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
  const { eventId, newStartDateTime, clientPhone, clientName, serviceType, duration, notes, barberId } = data;
  
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
    const newStartTime = parsePacificDateTime(newStartDateTime);
    const newEndTime = new Date(newStartTime.getTime() + (duration * 60000));

    // Update the event in Google Calendar
    const updatedEvent = await calendar.events.update({
      calendarId,
      eventId,
      resource: {
        ...existingEvent.data,
        start: { dateTime: newStartTime.toISOString(), timeZone: 'America/Los_Angeles' },
        end: { dateTime: newEndTime.toISOString(), timeZone: 'America/Los_Angeles' }
      },
      sendUpdates: 'all' // Notify attendees
    });

    // Update the appointment in the database
    const updateResult = await appointmentOps.updateByEventId(eventId, {
      start_time: newStartTime.toISOString(),
      end_time: newEndTime.toISOString()
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
  const { barberPhoneNumber, barberId, startDateTime, endDateTime } = req.body;
  if (!barberPhoneNumber && !barberId) return res.status(400).json({ success: false, error: 'Barber identifier required' });
  try {
    const barber = barberPhoneNumber ? await barberOps.getByPhoneNumber(barberPhoneNumber) : (await supabase.from('barbers').select('*').eq('id', barberId).single()).data;
    if (!barber?.refresh_token) return res.status(404).json({ success: false, error: 'Barber not found or unauthorized' });
    const oauth2Client = createOAuth2Client(barber.refresh_token);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = barber.selected_calendar_id || 'primary';

    // Use input datetimes directly, assuming they include timezone offset
    const timeMin = new Date(startDateTime).toISOString();
    const timeMax = new Date(endDateTime).toISOString();

    const response = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      timeZone: 'America/Los_Angeles',
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100
    });

    // Set the correct content type explicitly
    res.setHeader('Content-Type', 'application/json');
    
    // Send a clean, simplified response structure
    const result = {
      success: true,
      isAvailable: response.data.items.length === 0,
      events: response.data.items.map(event => ({
        id: event.id,
        summary: event.summary || "Untitled",
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date
      }))
    };
    
    // Use res.send with JSON.stringify to ensure proper formatting
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
  const { barberId, currentTimestamp, numSlots = 3 } = req.body;

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

    const slots = await findNextAvailableSlots(calendar, calendarId, currentTimestamp, numSlots);

    return res.status(200).json({
      success: true,
      slotsFound: slots.length,
      slots
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

router.post('/conversation/process-message', async (req, res) => {
  const { 
    phoneNumber, 
    content, 
    role = 'user', 
    timeWindowMs = 5000, 
    metadata = null,
    aggregateOnly = false // If true, only aggregates without storing
  } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number is required' 
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
    
    // Store the current message if content is provided and not aggregateOnly
    let storedMessage = null;
    if (content && !aggregateOnly) {
      storedMessage = await conversationOps.addMessage(
        session.id, 
        role, 
        content, 
        metadata
      );
    }
    
    // Get recent messages within the time window for aggregation
    const cutoffTime = new Date(Date.now() - timeWindowMs);
    const { data: recentMessages, error } = await supabase
      .from('conversation_messages')
      .select('*')
      .eq('session_id', session.id)
      .eq('role', 'user')
      .gt('created_at', cutoffTime.toISOString())
      .order('created_at', { ascending: true });
    
    if (error) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch recent messages' 
      });
    }
    
    // Aggregate messages
    let aggregatedContent = '';
    if (recentMessages.length > 0) {
      aggregatedContent = recentMessages.map(msg => msg.content).join(' ');
      
      // Mark all but the last message as processed
      if (recentMessages.length > 1) {
        const messageIds = recentMessages.slice(0, -1).map(msg => msg.id);
        await supabase
          .from('conversation_messages')
          .update({ metadata: { ...metadata, processed: true } })
          .in('id', messageIds);
      }
    }
    
    // Get conversation history (separate from recent messages)
    const history = await conversationOps.getConversationHistory(phoneNumber, 10);
    
    return res.status(200).json({
      success: true,
      storedMessage,
      aggregatedContent,
      messageCount: recentMessages.length,
      recentMessages,
      conversationHistory: history,
      sessionId: session.id
    });
  } catch (e) {
    console.error('Error in process-message:', e);
    return res.status(500).json({ 
      success: false, 
      error: e.message 
    });
  }
});

module.exports = router;
