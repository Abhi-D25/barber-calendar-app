const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { barberOps, clientOps, appointmentOps, conversationOps, supabase } = require('../utils/supabase');

const createOAuth2Client = (refreshToken) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
};

function parsePacificDateTime(dateTimeString) {
  let cleanDateString = dateTimeString;
  if (dateTimeString.includes('.')) {
    cleanDateString = dateTimeString.replace(/\.\d+(?=[Z+-])/, '');
  }
  try {
    const date = new Date(cleanDateString);
    if (!isNaN(date.getTime())) return date;
  } catch {}
  const match = cleanDateString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) throw new Error(`Invalid date format: ${dateTimeString}`);
  const [_, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(+year, +month - 1, +day, +hour + 7, +minute, +second));
}

async function handleCreateClientAppointment(calendar, calendarId, data, res) {
  const { clientPhone, clientName, serviceType, startDateTime, duration, notes, barberId } = data;
  if (!startDateTime) return res.status(400).json({ success: false, error: 'Start date-time is required' });
  const startTime = parsePacificDateTime(startDateTime);
  const endTime = new Date(startTime.getTime() + (duration * 60000));
  const eventDetails = {
    summary: `${serviceType}: ${clientName}`,
    description: `Client: ${clientName}\nPhone: ${clientPhone}\n${notes || ''}`,
    start: { dateTime: startTime.toISOString(), timeZone: 'America/Los_Angeles' },
    end: { dateTime: endTime.toISOString(), timeZone: 'America/Los_Angeles' }
  };
  const event = await calendar.events.insert({ calendarId, resource: eventDetails, sendUpdates: 'all' });
  if (event.data?.id) {
    try {
      await appointmentOps.create({ client_phone: clientPhone, barber_id: barberId, service_type: serviceType, start_time: startTime.toISOString(), end_time: endTime.toISOString(), google_calendar_event_id: event.data.id, notes });
    } catch (e) { console.error('DB store error:', e); }
  }
  return res.status(200).json({ success: true, action: 'create', eventId: event.data.id, eventLink: event.data.htmlLink, message: 'Appointment added to calendar' });
}

async function handleCancelAppointment(calendar, calendarId, eventId, clientPhone, res) {
  if (!eventId) {
    return res.status(400).json({ success: false, error: 'Event ID is required for cancellation' });
  }

  try {
    // Delete from Google Calendar
    await calendar.events.delete({
      calendarId,
      eventId,
      sendUpdates: 'all' // Notify attendees
    });

    // Delete from database
    const { data, error } = await supabase
      .from('appointments')
      .delete()
      .eq('google_calendar_event_id', eventId);

    if (error) {
      console.error('Error deleting appointment from database:', error);
    }

    return res.status(200).json({
      success: true,
      action: 'cancel',
      eventId,
      message: 'Appointment successfully cancelled'
    });
  } catch (e) {
    console.error('Error cancelling appointment:', e);
    return res.status(500).json({
      success: false,
      error: `Failed to cancel appointment: ${e.message}`
    });
  }
}

async function handleRescheduleAppointment(calendar, calendarId, data, res) {
  const { eventId, newStartDateTime, clientPhone, clientName, serviceType, duration = 30, notes, barberId } = data;
  
  if (!eventId || !newStartDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'Event ID and new start date-time are required for rescheduling' 
    });
  }

  try {
    // Get existing event first to preserve any other data
    const existingEvent = await calendar.events.get({
      calendarId,
      eventId
    });

    if (!existingEvent.data) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found in calendar'
      });
    }

    // Parse new start time and calculate new end time
    // Use the provided duration (which might be different from original)
    const newStartTime = parsePacificDateTime(newStartDateTime);
    const newEndTime = new Date(newStartTime.getTime() + (duration * 60000));

    // Update the event in Google Calendar
    const updatedEvent = await calendar.events.update({
      calendarId,
      eventId,
      resource: {
        ...existingEvent.data,
        summary: serviceType ? `${serviceType}: ${clientName}` : existingEvent.data.summary,
        start: { dateTime: newStartTime.toISOString(), timeZone: 'America/Los_Angeles' },
        end: { dateTime: newEndTime.toISOString(), timeZone: 'America/Los_Angeles' }
      },
      sendUpdates: 'all' // Notify attendees
    });

    // Update the appointment in the database
    const updateResult = await appointmentOps.updateByEventId(eventId, {
      start_time: newStartTime.toISOString(),
      end_time: newEndTime.toISOString(),
      service_type: serviceType || undefined // Only update if provided
    });

    return res.status(200).json({
      success: true,
      action: 'reschedule',
      eventId: updatedEvent.data.id,
      eventLink: updatedEvent.data.htmlLink,
      message: 'Appointment successfully rescheduled'
    });
  } catch (e) {
    console.error('Error rescheduling appointment:', e);
    return res.status(500).json({
      success: false,
      error: `Failed to reschedule appointment: ${e.message}`
    });
  }
}

router.post('/client-appointment', async (req, res) => {
  let { 
    clientPhone, 
    clientName = "New Client", 
    serviceType = 'Appointment', 
    startDateTime, 
    newStartDateTime, 
    duration = 30, 
    notes = '', 
    preferredBarberId, 
    isCancelling = false, 
    isRescheduling = false, 
    eventId 
  } = req.body;
  
  // Parse boolean strings to actual booleans
  if (typeof isCancelling === 'string') isCancelling = isCancelling.toLowerCase() === 'true';
  if (typeof isRescheduling === 'string') isRescheduling = isRescheduling.toLowerCase() === 'true';
  if (typeof duration === 'string') duration = parseInt(duration, 10) || 30;
  
  // Validate required fields
  if (!clientPhone) {
    return res.status(400).json({ success: false, error: 'Client phone number is required' });
  }
  
  try {
    // Get or create client
    let client = await clientOps.getByPhoneNumber(clientPhone);
    
    if (!client && !isCancelling && preferredBarberId) {
      client = await clientOps.createOrUpdate({ 
        phone_number: clientPhone, 
        name: clientName, 
        preferred_barber_id: preferredBarberId 
      });
    }
    
    // Validate barber info
    if (!preferredBarberId && (!client || !client.preferred_barber_id)) {
      return res.status(400).json({ 
        success: false, 
        error: 'No barber specified and client has no preferred barber' 
      });
    }
    
    const barberId = preferredBarberId || client?.preferred_barber_id;
    const { data: barber } = await supabase.from('barbers').select('*').eq('id', barberId).single();
    
    if (!barber?.refresh_token) {
      return res.status(404).json({ 
        success: false, 
        error: 'Barber not found or not authorized' 
      });
    }
    
    // Create Google Calendar client
    const oauth2Client = createOAuth2Client(barber.refresh_token);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = barber.selected_calendar_id || 'primary';
    
    // Handle different operations based on request type
    if (isCancelling) {
      return await handleCancelAppointment(calendar, calendarId, eventId, clientPhone, res);
    } else if (isRescheduling) {
      return await handleRescheduleAppointment(calendar, calendarId, {
        eventId,
        newStartDateTime,
        clientPhone,
        clientName,
        serviceType,
        duration,
        notes,
        barberId: barber.id
      }, res);
    } else {
      // Create new appointment
      return await handleCreateClientAppointment(calendar, calendarId, {
        clientPhone,
        clientName,
        serviceType,
        startDateTime,
        duration,
        notes,
        barberId: barber.id
      }, res);
    }
  } catch (e) {
    console.error('Error in client-appointment endpoint:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/update-client-preference', async (req, res) => {
  const { clientPhone, preferredBarberId } = req.body;
  if (!clientPhone || !preferredBarberId) return res.status(400).json({ success: false, error: 'Missing info' });
  try {
    const { data, error } = await supabase.from('clients').upsert({ phone_number: clientPhone, preferred_barber_id: preferredBarberId, updated_at: new Date() }, { onConflict: 'phone_number' }).select();
    if (error) throw error;
    return res.status(200).json({ success: true, client: data[0] });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/check-availability', async (req, res) => {
  const { barberPhoneNumber, barberId, startDateTime, endDateTime, serviceDuration = 30 } = req.body;
  
  if (!barberPhoneNumber && !barberId) return res.status(400).json({ success: false, error: 'Barber identifier required' });
  
  try {
    const barber = barberPhoneNumber ? await barberOps.getByPhoneNumber(barberPhoneNumber) : (await supabase.from('barbers').select('*').eq('id', barberId).single()).data;
    if (!barber?.refresh_token) return res.status(404).json({ success: false, error: 'Barber not found or unauthorized' });
    
    const oauth2Client = createOAuth2Client(barber.refresh_token);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = barber.selected_calendar_id || 'primary';

    // Parse specific start time from request
    const requestedStart = new Date(startDateTime);
    
    // Calculate the end time based on service duration
    const requestedEnd = new Date(requestedStart.getTime() + (serviceDuration * 60000));
    
    // Use a wider time window to fetch all potentially conflicting events
    const timeMin = new Date(requestedStart.getTime() - (60 * 60000)); // 1 hour before
    const timeMax = new Date(requestedEnd.getTime() + (60 * 60000));   // 1 hour after

    const response = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: 'America/Los_Angeles',
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100
    });

    // Check if any existing events overlap with the requested time slot
    const isAvailable = !response.data.items.some(event => {
      const eventStart = new Date(event.start.dateTime || event.start.date);
      const eventEnd = new Date(event.end.dateTime || event.end.date);
      
      // Check for overlap - if either the start or end time falls within an existing event
      return (
        (requestedStart < eventEnd && requestedEnd > eventStart) ||
        (eventStart < requestedEnd && eventEnd > requestedStart)
      );
    });
    
    // Set the correct content type explicitly
    res.setHeader('Content-Type', 'application/json');
    
    // Send a clean, simplified response structure
    const result = {
      success: true,
      isAvailable: isAvailable,
      requestedTimeSlot: {
        start: requestedStart.toISOString(),
        end: requestedEnd.toISOString(),
        duration: serviceDuration
      },
      conflictingEvents: isAvailable ? [] : response.data.items.map(event => ({
        id: event.id,
        summary: event.summary || "Untitled",
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date
      }))
    };
    
    return res.send(JSON.stringify(result));
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    return res.send(JSON.stringify({ success: false, error: e.message }));
  }
});

router.post('/register-client', async (req, res) => {
  const { clientName, clientPhone, preferredBarberName } = req.body;
  if (!clientName || !clientPhone || !preferredBarberName) return res.status(400).json({ success: false, error: 'Missing required fields' });
  try {
    let formattedPhone = clientPhone;
    const digits = formattedPhone.replace(/\D/g, '');
    if (!formattedPhone.startsWith('+')) formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    const { data: barber } = await supabase.from('barbers').select('id, name').ilike('name', `%${preferredBarberName}%`).single();
    const existingClient = await clientOps.getByPhoneNumber(formattedPhone);
    const updatedClient = await clientOps.createOrUpdate({ phone_number: formattedPhone, name: clientName, preferred_barber_id: barber.id });
    return res.status(200).json({ success: true, message: existingClient ? 'Client updated' : 'Client registered', client: updatedClient, barber });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/get-preferred-barber', async (req, res) => {
  const clientPhone = req.query.phone;
  if (!clientPhone) return res.status(400).json({ success: false, error: 'Phone number required' });
  try {
    let formattedPhone = clientPhone;
    const digits = formattedPhone.replace(/\D/g, '');
    if (!formattedPhone.startsWith('+')) formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;

    const client = await clientOps.getByPhoneNumber(formattedPhone);
    if (!client) return res.status(200).json({ success: true, found: false, message: 'Client not found' });

    let latestAppointment = null;
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('id, start_time, google_calendar_event_id')
      .eq('client_phone', formattedPhone)
      .order('start_time', { ascending: false })
      .limit(1);

    if (appointments && appointments.length > 0) {
      latestAppointment = appointments[0];
    }

    if (!client.preferred_barber) return res.status(200).json({
      success: true,
      found: false,
      message: 'No preferred barber',
      client: {
        id: client.id,
        name: client.name,
        phone: client.phone_number
      },
      latestAppointment
    });

    return res.status(200).json({
      success: true,
      found: true,
      barber: {
        id: client.preferred_barber.id,
        name: client.preferred_barber.name,
        phone: client.preferred_barber.phone_number
      },
      client: {
        id: client.id,
        name: client.name,
        phone: client.phone_number
      },
      latestAppointment
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Helper to find next N available 30-min slots from a given time
async function findNextAvailableSlots(calendar, calendarId, startFrom, numSlots = 3, slotMinutes = 30) {
  const results = [];
  let searchTime = new Date(startFrom);
  const endTime = new Date(searchTime);
  endTime.setDate(endTime.getDate() + 7);

  const busyEvents = await calendar.events.list({
    calendarId,
    timeMin: searchTime.toISOString(),
    timeMax: endTime.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250
  });

  const busy = busyEvents.data.items.map(evt => ({
    start: new Date(evt.start.dateTime || evt.start.date),
    end: new Date(evt.end.dateTime || evt.end.date)
  }));

  while (results.length < numSlots && searchTime < endTime) {
    const candidateEnd = new Date(searchTime.getTime() + slotMinutes * 60000);
    const overlaps = busy.some(evt =>
      (searchTime < evt.end && candidateEnd > evt.start)
    );
    if (!overlaps) {
      results.push({ start: new Date(searchTime), end: new Date(candidateEnd) });
      searchTime = new Date(candidateEnd);
    } else {
      searchTime.setMinutes(searchTime.getMinutes() + slotMinutes);
    }
  }

  return results.map(slot => ({
    start: slot.start.toISOString(),
    end: slot.end.toISOString()
  }));
}

// New endpoint: POST /find-available-slots
router.post('/find-available-slots', async (req, res) => {
  const { barberId, currentTimestamp, numSlots = 3, slotDurationMinutes = 30 } = req.body;

  if (!barberId || !currentTimestamp) {
    return res.status(400).json({ success: false, error: 'Missing barberId or currentTimestamp' });
  }

  try {
    const { data: barber } = await supabase.from('barbers').select('*').eq('id', barberId).single();
    if (!barber?.refresh_token) {
      return res.status(404).json({ success: false, error: 'Barber not found or unauthorized' });
    }

    const oauth2Client = createOAuth2Client(barber.refresh_token);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = barber.selected_calendar_id || 'primary';

    // Pass the slotDurationMinutes parameter here
    const slots = await findNextAvailableSlots(calendar, calendarId, currentTimestamp, numSlots, slotDurationMinutes);

    return res.status(200).json({
      success: true,
      slotsFound: slots.length,
      slots,
      duration: slotDurationMinutes // Return the duration for clarity
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/conversation/store-message', async (req, res) => {
  const { phoneNumber, role, content, metadata } = req.body;
  
  if (!phoneNumber || !role || !content) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields: phoneNumber, role, content' 
    });
  }
  
  try {
    // Get or create session
    const session = await conversationOps.getOrCreateSession(phoneNumber);
    if (!session) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to get or create session' 
      });
    }
    
    // Add message
    const message = await conversationOps.addMessage(
      session.id, 
      role, 
      content, 
      metadata
    );
    
    if (!message) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to store message' 
      });
    }
    
    return res.status(200).json({
      success: true,
      message,
      sessionId: session.id
    });
  } catch (e) {
    console.error('Error in store-message:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Get conversation history
router.get('/conversation/history', async (req, res) => {
  const { phoneNumber, limit = 10 } = req.query;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
    });
  }
  
  try {
    const history = await conversationOps.getConversationHistory(
      phoneNumber, 
      parseInt(limit)
    );
    
    return res.status(200).json({
      success: true,
      history,
      count: history.length
    });
  } catch (e) {
    console.error('Error in get-history:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Clear conversation history
router.post('/conversation/clear', async (req, res) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
    });
  }
  
  try {
    const cleared = await conversationOps.clearSession(phoneNumber);
    
    return res.status(200).json({
      success: cleared,
      message: cleared ? 'Session cleared successfully' : 'Failed to clear session'
    });
  } catch (e) {
    console.error('Error in clear-session:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Add this new endpoint to your webhook.js file

router.post('/conversation/process-message', async (req, res) => {
  const { 
    phoneNumber, 
    content, 
    role = 'user', 
    timeWindowMs = 5000,  // 5 second window by default
    metadata = null
  } = req.body;
  
  if (!phoneNumber || !content) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number and content are required' 
    });
  }
  
  try {
    const session = await conversationOps.getOrCreateSession(phoneNumber);
    if (!session) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to get or create session' 
      });
    }
    
    // Store the current message
    const message = await conversationOps.addMessage(
      session.id, 
      role, 
      content, 
      metadata
    );
    
    // Wait for the time window to check for additional messages
    await new Promise(resolve => setTimeout(resolve, timeWindowMs));
    
    // Get all messages within the time window
    // NOTE: We need to account for the fact that we already waited for timeWindowMs
    const cutoffTime = new Date(Date.now() - (timeWindowMs * 2));
    const { data: recentMessages, error } = await supabase
      .from('conversation_messages')
      .select('*')
      .eq('session_id', session.id)
      .eq('role', 'user')
      .gte('created_at', cutoffTime.toISOString())
      .order('created_at', { ascending: true });
    
    if (error) {
      console.error('Error fetching messages:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch recent messages',
        details: error.message
      });
    }
    
    console.log('Found messages:', recentMessages.length);
    console.log('Current message ID:', message.id);
    console.log('Messages:', recentMessages.map(m => ({ id: m.id, content: m.content, created_at: m.created_at })));
    
    // Check if newer messages exist
    const thisMessageId = message.id;
    const hasNewerMessages = recentMessages.some(msg => 
      msg.id !== thisMessageId && new Date(msg.created_at) > new Date(message.created_at)
    );
    
    if (hasNewerMessages) {
      // Not the final message
      return res.status(200).json({
        success: true,
        isFinalMessage: false,
        content: content,
        sessionId: session.id
      });
    }
    
    // Aggregate all messages including current
    const aggregatedContent = recentMessages
      .map(msg => msg.content)
      .join(' ');
    
    // Mark all messages as processed (if metadata exists)
    if (recentMessages.length > 0) {
      const messageIds = recentMessages.map(msg => msg.id);
      await supabase
        .from('conversation_messages')
        .update({ metadata: { processed: true } })
        .in('id', messageIds);
    }
    
    return res.status(200).json({
      success: true,
      isFinalMessage: true,
      content: aggregatedContent || content,
      sessionId: session.id,
      messageCount: recentMessages.length
    });
  } catch (e) {
    console.error('Error in process-message:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});


// Add a separate endpoint for checking if a message batch is complete
router.post('/conversation/check-batch-complete', async (req, res) => {
  const { phoneNumber, messageId, timeWindowMs = 5000 } = req.body;
  
  if (!phoneNumber || !messageId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number and message ID are required' 
    });
  }
  
  try {
    const session = await conversationOps.getOrCreateSession(phoneNumber);
    
    // Get the specific message
    const { data: currentMessage, error: msgError } = await supabase
      .from('conversation_messages')
      .select('*')
      .eq('id', messageId)
      .single();
    
    if (msgError || !currentMessage) {
      return res.status(404).json({ 
        success: false, 
        error: 'Message not found' 
      });
    }
    
    // Check for newer messages
    const { data: newerMessages, error } = await supabase
      .from('conversation_messages')
      .select('*')
      .eq('session_id', session.id)
      .eq('role', 'user')
      .gt('created_at', currentMessage.created_at);
    
    if (error) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to check for newer messages' 
      });
    }
    
    const isComplete = newerMessages.length === 0;
    
    if (isComplete) {
      // Get all messages in the batch for aggregation
      const cutoffTime = new Date(
        new Date(currentMessage.created_at).getTime() - timeWindowMs
      );
      
      const { data: batchMessages, error: batchError } = await supabase
        .from('conversation_messages')
        .select('*')
        .eq('session_id', session.id)
        .eq('role', 'user')
        .gt('created_at', cutoffTime.toISOString())
        .order('created_at', { ascending: true });
      
      if (batchError) {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to fetch batch messages' 
        });
      }
      
      const aggregatedContent = batchMessages
        .map(msg => msg.content)
        .join(' ');
      
      return res.status(200).json({
        success: true,
        isComplete: true,
        aggregatedContent,
        messageCount: batchMessages.length
      });
    }
    
    return res.status(200).json({
      success: true,
      isComplete: false
    });
  } catch (e) {
    console.error('Error in check-batch-complete:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Store temporary messages as a conversation
router.post('/store-temp-messages', async (req, res) => {
  const { phoneNumber, role = "user", messages, content } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
    });
  }
  
  try {
    // Get or create session
    const session = await conversationOps.getOrCreateSession(phoneNumber);
    if (!session) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to get or create session' 
      });
    }
    
    // Get the most recent message with temp_messages
    const { data: existingData, error: fetchError } = await supabase
      .from('conversation_messages')
      .select('*')
      .eq('session_id', session.id)
      .filter('metadata->is_temp', 'eq', true)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (fetchError) {
      console.error('Error fetching existing temp messages:', fetchError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch existing temp messages',
        details: fetchError.message
      });
    }
    
    // Initialize conversation array
    let conversation = [];
    
    // If we have existing data, use it as the base
    if (existingData && existingData.length > 0 && existingData[0].temp_messages) {
      if (Array.isArray(existingData[0].temp_messages)) {
        conversation = existingData[0].temp_messages;
      } else {
        // If it's not an array, initialize with a single entry
        conversation = [{ role: "system", content: "Conversation initialized" }];
      }
    } else {
      // Start a new conversation
      conversation = [{ role: "system", content: "Conversation initialized" }];
    }
    
    // Add the new message to the conversation
    if (content || messages) {
      // If it's a direct content string, add it as a message
      if (content) {
        conversation.push({
          role: role,
          content: content
        });
      } 
      // If it's a messages object, add it
      else if (messages) {
        if (typeof messages === 'string') {
          conversation.push({
            role: role,
            content: messages
          });
        } else {
          // If it's already an object or array, try to handle it intelligently
          if (Array.isArray(messages)) {
            // If it's an array, append all messages
            conversation = [...conversation, ...messages];
          } else if (messages.content) {
            // If it has content, treat as a single message
            conversation.push({
              role: messages.role || role,
              content: messages.content
            });
          } else {
            // Fallback: just stringify and store
            conversation.push({
              role: role,
              content: JSON.stringify(messages)
            });
          }
        }
      }
    }
    
    // Store the updated conversation
    const { data, error } = await supabase
      .from('conversation_messages')
      .upsert({ 
        session_id: session.id,
        role: 'system', // This is a system message to store the temp conversation
        content: 'Temporary conversation storage',
        temp_messages: conversation,
        metadata: { is_temp: true },
        created_at: new Date().toISOString() // Use current timestamp
      });
    
    if (error) {
      console.error('Error storing temp messages:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to store temporary messages',
        details: error.message
      });
    }
    
    return res.status(200).json({
      success: true,
      message: 'Temporary messages stored successfully',
      sessionId: session.id,
      conversationLength: conversation.length
    });
  } catch (e) {
    console.error('Error in store-temp-messages:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Check temporary messages - formatted for OpenAI context
router.get('/check-temp-messages', async (req, res) => {
  const { phoneNumber } = req.query;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
    });
  }
  
  try {
    // Get the session
    const session = await conversationOps.getOrCreateSession(phoneNumber);
    if (!session) {
      return res.status(404).json({ 
        success: false, 
        error: 'Session not found' 
      });
    }
    
    // Get the most recent message with temp_messages
    const { data, error } = await supabase
      .from('conversation_messages')
      .select('*')
      .eq('session_id', session.id)
      .filter('metadata->is_temp', 'eq', true)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) {
      console.error('Error checking temp messages:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to check temporary messages',
        details: error.message
      });
    }
    
    // Format the conversation for easy reading
    let formattedConversation = '';
    let rawConversation = [];
    
    if (data && data.length > 0 && data[0].temp_messages) {
      rawConversation = data[0].temp_messages;
      
      // Skip the first system message in formatting
      for (let i = 1; i < rawConversation.length; i++) {
        const msg = rawConversation[i];
        if (msg.role && msg.content) {
          // Add a formatted line to the conversation
          formattedConversation += `${msg.role.toUpperCase()}: ${msg.content}\n\n`;
        }
      }
    }
    
    return res.status(200).json({
      success: true,
      conversation: formattedConversation.trim(),
      rawConversation: rawConversation,
      hasMessages: rawConversation.length > 1 // More than just the system message
    });
  } catch (e) {
    console.error('Error in check-temp-messages:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Create a new client
router.post('/create-client', async (req, res) => {
  const { 
    phoneNumber, 
    name = "New Client", 
    preferredBarberId 
  } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
    });
  }
  
  try {
    // Format phone number
    let formattedPhone = phoneNumber;
    const digits = formattedPhone.replace(/\D/g, '');
    if (!formattedPhone.startsWith('+')) {
      formattedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    }
    
    // Check if the client already exists
    const existingClient = await clientOps.getByPhoneNumber(formattedPhone);
    
    if (existingClient) {
      // Update client if it exists
      const updatedClient = await clientOps.createOrUpdate({
        phone_number: formattedPhone,
        name,
        preferred_barber_id: preferredBarberId || existingClient.preferred_barber_id
      });
      
      return res.status(200).json({
        success: true,
        message: 'Client information updated',
        client: updatedClient,
        isNew: false
      });
    }
    
    // Create a new client
    const newClient = await clientOps.createOrUpdate({
      phone_number: formattedPhone,
      name,
      preferred_barber_id: preferredBarberId
    });
    
    if (!newClient) {
      return res.status(500).json({
        success: false,
        error: 'Failed to create client'
      });
    }
    
    return res.status(200).json({
      success: true,
      message: 'New client created successfully',
      client: newClient,
      isNew: true
    });
  } catch (e) {
    console.error('Error in create-client:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Clear temporary messages
router.post('/clear-temp-messages', async (req, res) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
    });
  }
  
  try {
    // Get the session
    const session = await conversationOps.getOrCreateSession(phoneNumber);
    if (!session) {
      return res.status(404).json({ 
        success: false, 
        error: 'Session not found' 
      });
    }
    
    // Clear temp messages
    const { data, error } = await supabase
      .from('conversation_messages')
      .update({ 
        temp_messages: null,
        metadata: { is_temp: false }
      })
      .eq('session_id', session.id)
      .filter('metadata->is_temp', 'eq', true);  // Changed this line
    
    if (error) {
      console.error('Error clearing temp messages:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to clear temporary messages',
        details: error.message
      });
    }
    
    return res.status(200).json({
      success: true,
      message: 'Temporary messages cleared successfully'
    });
  } catch (e) {
    console.error('Error in clear-temp-messages:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

// Look up barber ID by name
router.get('/lookup-barber-id', async (req, res) => {
  const { barberName } = req.query;
  
  if (!barberName) {
    return res.status(400).json({ 
      success: false, 
      error: 'Barber name is required' 
    });
  }
  
  try {
    // Search for barber with similar name (case insensitive)
    const { data, error } = await supabase
      .from('barbers')
      .select('id, name, phone_number')
      .ilike('name', `%${barberName}%`)
      .limit(1);
    
    if (error) {
      console.error('Error looking up barber:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to look up barber',
        details: error.message
      });
    }
    
    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No barber found with that name',
        barberName
      });
    }
    
    return res.status(200).json({
      success: true,
      barber: data[0],
      barberId: data[0].id,
      barberName: data[0].name
    });
  } catch (e) {
    console.error('Error in lookup-barber-id:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

module.exports = router;
