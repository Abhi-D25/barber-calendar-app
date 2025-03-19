const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { barberOps, clientOps, appointmentOps, supabase } = require('../utils/supabase');

// Create OAuth2 client
const createOAuth2Client = (refreshToken) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  
  oauth2Client.setCredentials({
    refresh_token: refreshToken
  });
  
  return oauth2Client;
};

// Find event by client name and approximate date
async function findEventByClientName(calendar, calendarId, clientName, appointmentDate) {
  // Use a wider search window: 30 days before and after the current date
  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - 30); // Look back 30 days
  
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + 60); // Look ahead 60 days
  
  console.log(`Searching for events with client: "${clientName}", between ${timeMin.toISOString()} and ${timeMax.toISOString()}`);
  
  // Get all events in the date range
  const response = await calendar.events.list({
    calendarId: calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 100 // Get a reasonable number of events
  });
  
  console.log(`Found ${response.data.items.length} total events in calendar`);
  
  // Create normalized client name for more flexible matching
  const normalizedSearchName = clientName.toLowerCase().trim();
  
  // Filter events that might contain the client name
  const matchingEvents = response.data.items.filter(event => {
    // Check the summary (title)
    const summary = (event.summary || '').toLowerCase();
    
    // Check the description
    const description = (event.description || '').toLowerCase();
    
    // Look for the client name in either field
    return summary.includes(normalizedSearchName) || 
           description.includes(normalizedSearchName);
  });
  
  console.log(`Found ${matchingEvents.length} potential matches for "${clientName}"`);
  
  if (matchingEvents.length === 0) {
    // No matches found
    return null;
  }
  
  if (matchingEvents.length === 1) {
    // Only one match, return it
    return matchingEvents[0];
  }
  
  // Multiple matches - if we have a date hint, use it to find the closest match
  if (appointmentDate) {
    const targetDate = new Date(appointmentDate);
    
    // Sort by closest to the target date
    matchingEvents.sort((a, b) => {
      const dateA = new Date(a.start.dateTime || a.start.date);
      const dateB = new Date(b.start.dateTime || b.start.date);
      
      const diffA = Math.abs(dateA - targetDate);
      const diffB = Math.abs(dateB - targetDate);
      
      return diffA - diffB;
    });
    
    // Return the closest match
    return matchingEvents[0];
  }
  
  // If no date hint, return the next upcoming event for this client
  const now = new Date();
  const upcomingEvents = matchingEvents.filter(event => {
    const eventDate = new Date(event.start.dateTime || event.start.date);
    return eventDate >= now;
  });
  
  if (upcomingEvents.length > 0) {
    // Sort by date (ascending)
    upcomingEvents.sort((a, b) => {
      const dateA = new Date(a.start.dateTime || a.start.date);
      const dateB = new Date(b.start.dateTime || b.start.date);
      return dateA - dateB;
    });
    
    // Return the next upcoming event
    return upcomingEvents[0];
  }
  
  // If no upcoming events, return the most recent past event
  matchingEvents.sort((a, b) => {
    const dateA = new Date(a.start.dateTime || a.start.date);
    const dateB = new Date(b.start.dateTime || b.start.date);
    return dateB - dateA; // Descending order
  });
  
  return matchingEvents[0];
}

// Main webhook endpoint to handle calendar operations
router.post('/create-event', async (req, res) => {
  const { 
    action = 'create', // Default action is create
    phoneNumber, 
    startDateTime,
    clientName,
    duration = 30,
    service = 'Appointment',
    notes,
    eventId // Optional - can be found by client name if not provided
  } = req.body;
  
  console.log('Webhook received:', { action, phoneNumber, clientName, startDateTime });
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Barber phone number is required' 
    });
  }
  
  try {
    // Find barber by phone number
    const barber = await barberOps.getByPhoneNumber(phoneNumber);
    
    if (!barber || !barber.refresh_token) {
      return res.status(404).json({ 
        success: false, 
        error: 'Barber not found or not authorized'
      });
    }
    
    // Create OAuth2 client with barber's refresh token
    const oauth2Client = createOAuth2Client(barber.refresh_token);
    
    // Create Calendar API client
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Get calendar ID
    const calendarId = barber.selected_calendar_id || 'primary';
    
    // Handle different actions
    switch(action.toLowerCase()) {
      case 'create':
        return await handleCreateEvent(calendar, calendarId, req.body, barber, res);
      
      case 'cancel':
        return await handleCancelEvent(calendar, calendarId, eventId, clientName, startDateTime, res);
      
      case 'reschedule':
        return await handleRescheduleEvent(calendar, calendarId, eventId, req.body, res);
      
      default:
        return res.status(400).json({
          success: false,
          error: `Unknown action: ${action}`
        });
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
    
    return res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || 'Unknown error'
    });
  }
});

// Add this new endpoint for client-initiated appointments
router.post('/client-appointment', async (req, res) => {
  let {
    clientPhone,
    clientName = "New Client",
    serviceType = 'Appointment',
    startDateTime,
    newStartDateTime, // For rescheduling
    duration = 30,
    notes = '',
    preferredBarberId,
    isCancelling = false,
    isRescheduling = false,
    eventId // Optional for cancel/reschedule
  } = req.body;

  // Convert boolean strings to actual booleans if needed
  if (typeof isCancelling === 'string') {
    isCancelling = isCancelling.toLowerCase() === 'true';
  }
  if (typeof isRescheduling === 'string') {
    isRescheduling = isRescheduling.toLowerCase() === 'true';
  }
  
  // Convert duration to number if it's a string
  if (typeof duration === 'string') {
    duration = parseInt(duration, 10) || 30;
  }

  console.log('Client appointment webhook received:', { 
    clientPhone, clientName, serviceType, startDateTime, 
    newStartDateTime, duration, preferredBarberId,
    isCancelling, isRescheduling, eventId
  });

  if (!clientPhone) {
    return res.status(400).json({
      success: false,
      error: 'Client phone number is required'
    });
  }

  try {
    // Get client details from the database
    let client = await clientOps.getByPhoneNumber(clientPhone);
    
    // If client doesn't exist, create a new one (for new appointments only)
    if (!client && !isCancelling && preferredBarberId) {
      console.log(`Client ${clientPhone} not found, creating new entry`);
      const newClient = {
        phone_number: clientPhone,
        name: clientName,
        preferred_barber_id: preferredBarberId
      };
      
      try {
        client = await clientOps.createOrUpdate(newClient);
        console.log('Created new client:', client);
      } catch (createErr) {
        console.error('Error creating client:', createErr);
      }
    }
    
    // Determine which barber to use
    if (!preferredBarberId && (!client || !client.preferred_barber_id)) {
      return res.status(400).json({
        success: false,
        error: 'No barber specified and client has no preferred barber'
      });
    }
    
    // Use provided barber ID or client's preferred barber
    let barberId = preferredBarberId || (client ? client.preferred_barber_id : null);

    // Get barber details from the database
    const { data: barber, error: barberError } = await supabase
      .from('barbers')
      .select('*')
      .eq('id', barberId)
      .single();

    if (barberError || !barber || !barber.refresh_token) {
      return res.status(404).json({
        success: false,
        error: 'Barber not found or not authorized',
        details: barberError
      });
    }

    // Create OAuth2 client with barber's refresh token
    const oauth2Client = createOAuth2Client(barber.refresh_token);
    
    // Create Calendar API client
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Get calendar ID
    const calendarId = barber.selected_calendar_id || 'primary';

    // Handle different operations based on flags
    if (isCancelling) {
      // Handle cancellation
      return await handleCancelClientAppointment(
        calendar, 
        calendarId, 
        eventId, 
        clientName || client?.name, 
        clientPhone,
        startDateTime, 
        res
      );
    } else if (isRescheduling) {
      // Handle rescheduling
      return await handleRescheduleClientAppointment(
        calendar, 
        calendarId, 
        eventId,
        clientName || client?.name,
        clientPhone, 
        startDateTime,
        newStartDateTime || startDateTime, 
        duration,
        res
      );
    } else {
      // Handle creation (default)
      return await handleCreateClientAppointment(
        calendar, 
        calendarId, 
        {
          clientPhone,
          clientName: clientName || (client ? client.name : 'New Client'),
          serviceType,
          startDateTime,
          duration,
          notes,
          barberId: barber.id
        }, 
        res
      );
    }
  } catch (error) {
    console.error('Client appointment processing error:', error);
    
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
      details: error.response?.data || 'Unknown error'
    });
  }
});

async function handleCreateClientAppointment(calendar, calendarId, data, res) {
  const { clientPhone, clientName, serviceType, startDateTime, duration, notes, barberId } = data;
  
  if (!startDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'Start date-time is required for creating appointments' 
    });
  }
  
  // Parse dates with timezone handling
  const startTime = parsePacificDateTime(startDateTime);
  const endTime = new Date(startTime.getTime() + (duration * 60000));
  
  // Format as ISO strings
  const startTimeIso = startTime.toISOString();
  const endTimeIso = endTime.toISOString();
  
  // Prepare event details
  const eventSummary = clientName 
    ? `${serviceType}: ${clientName}`
    : serviceType;
    
  const eventDetails = {
    summary: eventSummary,
    description: `Client: ${clientName}\nPhone: ${clientPhone}\n${notes || ''}`,
    start: {
      dateTime: startTimeIso,
      timeZone: 'America/Los_Angeles'
    },
    end: {
      dateTime: endTimeIso,
      timeZone: 'America/Los_Angeles'
    }
  };
  
  // Create event
  const event = await calendar.events.insert({
    calendarId: calendarId,
    resource: eventDetails,
    sendUpdates: 'all'
  });
  
  // Store appointment in database
  if (event.data && event.data.id) {
    try {
      await appointmentOps.create({
        client_phone: clientPhone,
        barber_id: barberId,
        service_type: serviceType,
        start_time: startTimeIso,
        end_time: endTimeIso,
        google_calendar_event_id: event.data.id,
        notes: notes || ''
      });
    } catch (dbError) {
      console.error('Error storing appointment in database:', dbError);
      // Continue anyway since the calendar event was created
    }
  }
  
  // Return success response
  return res.status(200).json({
    success: true,
    action: 'create',
    eventId: event.data.id,
    eventLink: event.data.htmlLink,
    message: 'Appointment added to calendar'
  });
}

// Helper function for cancelling client appointments
// Helper function for cancelling client appointments
async function handleCancelClientAppointment(calendar, calendarId, eventId, clientName, clientPhone, startDateTime, res) {
  try {
    // If no eventId is provided, try to find by client info
    let eventToCancel = null;
    
    if (!eventId) {
      if (!clientName && !clientPhone) {
        return res.status(400).json({ 
          success: false, 
          error: 'Either event ID or client information is required for cancelling events' 
        });
      }
      
      // Try to find the event by client name or phone (might be in description)
      const searchTerm = clientName || clientPhone;
      eventToCancel = await findEventByClientName(
        calendar, 
        calendarId, 
        searchTerm, 
        startDateTime ? new Date(startDateTime) : null
      );
      
      if (!eventToCancel) {
        return res.status(404).json({
          success: false,
          error: `No matching event found for client "${searchTerm}"`
        });
      }
      
      eventId = eventToCancel.id;
      console.log(`Found event to cancel: ${eventId} (${eventToCancel.summary})`);
    } else {
      // Verify the event exists
      try {
        eventToCancel = await calendar.events.get({
          calendarId: calendarId,
          eventId: eventId
        });
      } catch (getErr) {
        if (getErr.response && getErr.response.status === 404) {
          return res.status(404).json({
            success: false,
            error: 'Event not found with the provided ID'
          });
        }
        throw getErr;
      }
    }
    
    // Event exists, delete it from Google Calendar
    await calendar.events.delete({
      calendarId: calendarId,
      eventId: eventId,
      sendUpdates: 'all' // Send update notifications
    });
    
    // Delete the appointment from the database instead of updating status
    try {
      const { data, error } = await supabase
        .from('appointments')
        .delete()
        .eq('google_calendar_event_id', eventId);
        
      if (error) {
        console.error('Error deleting appointment from database:', error);
      } else {
        console.log('Successfully deleted appointment from database');
      }
    } catch (dbError) {
      console.error('Database error when deleting appointment:', dbError);
    }
    
    return res.status(200).json({
      success: true,
      action: 'cancel',
      eventId: eventId,
      message: 'Appointment successfully cancelled and removed from database'
    });
  } catch (error) {
    console.error('Error cancelling event:', error);
    throw error;
  }
}

// Helper function for rescheduling client appointments
async function handleRescheduleClientAppointment(calendar, calendarId, eventId, clientName, clientPhone, oldStartDateTime, newStartDateTime, duration, res) {
  if (!newStartDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'New start date-time is required for rescheduling' 
    });
  }
  
  try {
    // If no eventId is provided, try to find by client info
    let existingEvent;
    
    if (!eventId) {
      if (!clientName && !clientPhone) {
        return res.status(400).json({ 
          success: false, 
          error: 'Either event ID or client information is required for rescheduling' 
        });
      }
      
      // Try to find the event by client name or phone
      const searchTerm = clientName || clientPhone;
      const foundEvent = await findEventByClientName(
        calendar, 
        calendarId, 
        searchTerm, 
        oldStartDateTime ? new Date(oldStartDateTime) : null
      );
      
      if (!foundEvent) {
        return res.status(404).json({
          success: false,
          error: `No matching event found for client "${searchTerm}"`
        });
      }
      
      eventId = foundEvent.id;
      existingEvent = { data: foundEvent };
      console.log(`Found event to reschedule: ${eventId} (${foundEvent.summary})`);
    } else {
      // Get the existing event details
      try {
        existingEvent = await calendar.events.get({
          calendarId: calendarId,
          eventId: eventId
        });
      } catch (getErr) {
        if (getErr.response && getErr.response.status === 404) {
          return res.status(404).json({
            success: false,
            error: 'Event not found with the provided ID'
          });
        }
        throw getErr;
      }
    }
    
    const startTime = parsePacificDateTime(newStartDateTime);
    const endTime = new Date(startTime.getTime() + (duration * 60000));
    
    // Prepare updated event details - keep everything except the times
    const updatedEvent = {
      ...existingEvent.data,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: 'America/Los_Angeles'
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: 'America/Los_Angeles'
      }
    };
    
    // Update the event
    const result = await calendar.events.update({
      calendarId: calendarId,
      eventId: eventId,
      resource: updatedEvent,
      sendUpdates: 'all' // Send update notifications
    });
    
    // Try to update appointment in database
    try {
      const { data, error } = await supabase
        .from('appointments')
        .update({ 
          start_time: startTime.toISOString(),
          end_time: endTime.toISOString(),
          updated_at: new Date()
        })
        .eq('google_calendar_event_id', eventId);
        
      if (error) {
        console.error('Error updating appointment times:', error);
      }
    } catch (dbError) {
      console.error('Database error when rescheduling appointment:', dbError);
    }
    
    return res.status(200).json({
      success: true,
      action: 'reschedule',
      eventId: result.data.id,
      eventLink: result.data.htmlLink,
      message: 'Appointment successfully rescheduled'
    });
  } catch (error) {
    console.error('Error rescheduling event:', error);
    throw error;
  }
}

// Add endpoint for updating client preferences
router.post('/update-client-preference', async (req, res) => {
  const {
    clientPhone,
    preferredBarberId
  } = req.body;

  console.log('Update client preference webhook received:', { clientPhone, preferredBarberId });

  if (!clientPhone || !preferredBarberId) {
    return res.status(400).json({
      success: false,
      error: 'Client phone number and preferred barber ID are required'
    });
  }

  try {
    // Check if client exists
    const client = await clientOps.getByPhoneNumber(clientPhone);
    
    // Update or create client with preferred barber
    const { data, error } = await supabase
      .from('clients')
      .upsert({
        phone_number: clientPhone,
        preferred_barber_id: preferredBarberId,
        updated_at: new Date()
      }, {
        onConflict: 'phone_number'
      })
      .select();
      
    if (error) {
      console.error('Error updating client preference:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update client preference'
      });
    }
    
    return res.status(200).json({
      success: true,
      action: 'update-preference',
      message: 'Client preference updated successfully',
      client: data[0]
    });

  } catch (error) {
    console.error('Update client preference error:', error);
    
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Add endpoint for checking barber availability
router.post('/check-availability', async (req, res) => {
  const {
    barberPhoneNumber,
    barberId,
    startDateTime,
    endDateTime,
    returnFormat = "zapier"
  } = req.body;

  // Log the incoming request
  console.log('Check availability webhook received:', { barberPhoneNumber, barberId, startDateTime, endDateTime });

  if (!barberPhoneNumber && !barberId) {
    return res.status(400).json({
      success: false,
      error: 'Either barber phone number or barber ID is required'
    });
  }

  try {
    // Find barber
    let barber;
    if (barberPhoneNumber) {
      barber = await barberOps.getByPhoneNumber(barberPhoneNumber);
    } else {
      const { data, error } = await supabase
        .from('barbers')
        .select('*')
        .eq('id', barberId)
        .single();
      barber = data;
    }

    if (!barber || !barber.refresh_token) {
      return res.status(404).json({
        success: false,
        error: 'Barber not found or not authorized'
      });
    }

    // Create OAuth2 client with barber's refresh token
    const oauth2Client = createOAuth2Client(barber.refresh_token);
    
    // Create Calendar API client
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Get calendar ID
    const calendarId = barber.selected_calendar_id || 'primary';

    // DIRECT APPROACH: Manually create Pacific time dates with correct offset
    // Extract date and time components
    let startComponents = startDateTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
    let endComponents = endDateTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
    
    if (!startComponents || !endComponents) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format. Expected YYYY-MM-DDTHH:MM:SS'
      });
    }
    
    // Convert string times to Pacific time by creating correctly formatted strings with timezone offset
    // For March 2025, Pacific time should be PDT (-07:00)
    const pacificStartTime = `${startDateTime.split('.')[0]}-07:00`;
    const pacificEndTime = `${endDateTime.split('.')[0]}-07:00`;
    
    // Parse these as dates
    const timeMin = new Date(pacificStartTime);
    const timeMax = new Date(pacificEndTime);
    
    console.log('Using Pacific time interpretation:');
    console.log('Pacific start time:', pacificStartTime);
    console.log('Pacific end time:', pacificEndTime);
    console.log('Converted timeMin:', timeMin.toISOString());
    console.log('Converted timeMax:', timeMax.toISOString());

    // Get events in this time range with explicit Pacific timezone
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: 'America/Los_Angeles', // This tells Google Calendar to interpret the times in Pacific timezone
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100
    });

    const events = response.data.items;
    console.log(`Found ${events.length} events in calendar for the specified time range`);
    
    // If the returnFormat is "zapier", format the response to match Zapier's Google Calendar output
    if (returnFormat === "zapier") {
      // Transform the events to match Zapier's output format
      const formattedEvents = events.map(event => {
        const startTime = new Date(event.start.dateTime || event.start.date);
        const endTime = new Date(event.end.dateTime || event.end.date);
        
        return {
          "Event ID": event.id,
          "Event Begins": startTime.toISOString(),
          "Event Ends": endTime.toISOString(),
          "Event Name": event.summary || "Untitled Event",
          "Event Description": event.description || "",
          "Event Location": event.location || "",
          "Event Link": event.htmlLink || "",
          "Calendar ID": calendarId,
          "Created": event.created || "",
          "Updated": event.updated || "",
          "Creator Email": event.creator?.email || ""
        };
      });
      
      // Return the events in Zapier's format with debugging info
      return res.status(200).json({
        events: formattedEvents,
        debug: {
          searchTimeRange: {
            start: timeMin.toISOString(),
            end: timeMax.toISOString(),
            pacificStart: pacificStartTime,
            pacificEnd: pacificEndTime
          },
          calendarId: calendarId,
          eventsFound: events.length
        }
      });
    } else {
      // Standard format response
      return res.status(200).json({
        success: true,
        action: 'check-availability',
        barberName: barber.name,
        isAvailable: events.length === 0,
        events: events.map(event => ({
          id: event.id,
          summary: event.summary,
          start: event.start.dateTime || event.start.date,
          end: event.end.dateTime || event.end.date
        })),
        debug: {
          searchTimeRange: {
            start: timeMin.toISOString(),
            end: timeMax.toISOString()
          },
          calendarId: calendarId,
          eventsFound: events.length
        }
      });
    }
  } catch (error) {
    console.error('Check availability error:', error);
    
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
      details: error.response?.data || 'Unknown error'
    });
  }
});

// Helper function to create a new event
function parsePacificDateTime(dateTimeString) {
  // If the string already has timezone info, parse it directly
  if (dateTimeString.includes('Z') || 
      dateTimeString.includes('+') || 
      dateTimeString.includes('-')) {
    return new Date(dateTimeString);
  }
  
  // Extract date components
  const match = dateTimeString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  
  if (!match) {
    throw new Error(`Invalid date format: ${dateTimeString}`);
  }
  
  // Extract components - year, month, day, hour, minute, second
  const [_, year, month, day, hour, minute, second] = match;
  
  // Create a date string with explicit Pacific timezone
  // Instead of hardcoding +7, we'll create a date in Pacific time zone
  
  // Method 1: Using the date in Pacific timezone directly
  const pacificDate = new Date(`${dateTimeString} Pacific Time`);
  if (!isNaN(pacificDate.getTime())) {
    return pacificDate;
  }
  
  // If that doesn't work (older Node versions), fall back to method 2
  // Use the Intl formatter to find the correct offset for this date
  const tempDate = new Date(
    parseInt(year, 10),
    parseInt(month, 10) - 1,
    parseInt(day, 10),
    parseInt(hour, 10),
    parseInt(minute, 10),
    parseInt(second || 0, 10)
  );
  
  // Get the offset for Pacific Time on this date
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });
  
  // Get timezone name (e.g., "PDT" or "PST")
  const tzName = formatter.format(tempDate).split(' ').pop();
  
  // Determine offset based on timezone name
  let offset;
  if (tzName === 'PDT') {
    offset = '-07:00'; // Pacific Daylight Time
  } else {
    offset = '-08:00'; // Pacific Standard Time
  }
  
  // Create a date string with the correct offset
  const dateWithTz = `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
  return new Date(dateWithTz);
}

// Modify in handleCreateEvent function
async function handleCreateEvent(calendar, calendarId, data, barber, res) {
  const { startDateTime, clientName, duration, service, notes } = data;
  
  if (!startDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'Start date-time is required for creating events' 
    });
  }
  
  // Parse dates with timezone handling
  const startTime = parsePacificDateTime(startDateTime);
  const endTime = new Date(startTime.getTime() + (duration * 60000));
  
  // Format as ISO strings
  const startTimeIso = startTime.toISOString();
  const endTimeIso = endTime.toISOString();
  
  // Prepare event details
  const eventSummary = clientName 
    ? `${service}: ${clientName}`
    : service;
    
  const eventDetails = {
    summary: eventSummary,
    description: notes || 'Booking via SMS',
    start: {
      dateTime: startTimeIso,
      timeZone: 'America/Los_Angeles' // Explicitly set timezone for Google Calendar
    },
    end: {
      dateTime: endTimeIso,
      timeZone: 'America/Los_Angeles'
    }
  };
  
  // Create event
  const event = await calendar.events.insert({
    calendarId: calendarId,
    resource: eventDetails,
    sendUpdates: 'all'
  });
  
  // Store appointment in database
  if (event.data && event.data.id) {
    try {
      // Use client's name if provided, otherwise use "Unknown"
      const clientPhoneOrName = clientName || 'Unknown Client';
      
      await appointmentOps.create({
        client_phone: clientPhoneOrName,
        barber_id: barber.id,
        service_type: service,
        start_time: startTimeIso,
        end_time: endTimeIso,
        google_calendar_event_id: event.data.id,
        notes: notes || ''
      });
    } catch (dbError) {
      console.error('Error storing appointment in database:', dbError);
      // Continue anyway since the calendar event was created
    }
  }
  
  // Return success response
  return res.status(200).json({
    success: true,
    action: 'create',
    eventId: event.data.id,
    eventLink: event.data.htmlLink,
    message: 'Appointment added to calendar'
  });
}

// Helper function to cancel an event
async function handleCancelEvent(calendar, calendarId, eventId, clientName, startDateTime, res) {
  try {
    // If no eventId is provided, try to find by client name
    let eventToCancel = null;
    
    if (!eventId) {
      if (!clientName) {
        return res.status(400).json({ 
          success: false, 
          error: 'Either event ID or client name is required for cancelling events' 
        });
      }
      
      // Try to find the event by client name
      eventToCancel = await findEventByClientName(
        calendar, 
        calendarId, 
        clientName, 
        startDateTime ? new Date(startDateTime) : null
      );
      
      if (!eventToCancel) {
        return res.status(404).json({
          success: false,
          error: `No matching event found for client "${clientName}"`
        });
      }
      
      eventId = eventToCancel.id;
      console.log(`Found event to cancel: ${eventId} (${eventToCancel.summary})`);
    } else {
      // Verify the event exists
      try {
        eventToCancel = await calendar.events.get({
          calendarId: calendarId,
          eventId: eventId
        });
      } catch (getErr) {
        if (getErr.response && getErr.response.status === 404) {
          return res.status(404).json({
            success: false,
            error: 'Event not found with the provided ID'
          });
        }
        throw getErr;
      }
    }
    
    // Event exists, delete it
    await calendar.events.delete({
      calendarId: calendarId,
      eventId: eventId,
      sendUpdates: 'all' // Send update notifications
    });
    
    // Update appointment status in database if needed
    // Implement database update logic here
    
    return res.status(200).json({
      success: true,
      action: 'cancel',
      eventId: eventId,
      message: 'Appointment successfully cancelled'
    });
  } catch (error) {
    console.error('Error cancelling event:', error);
    
    // Re-throw for the main error handler
    throw error;
  }
}

// Helper function to reschedule an event
async function handleRescheduleEvent(calendar, calendarId, eventId, data, res) {
  const { startDateTime, clientName, duration = 30 } = data;
  
  if (!startDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'New start date-time is required for rescheduling' 
    });
  }
  
  try {
    // If no eventId is provided, try to find by client name
    let existingEvent;
    
    if (!eventId) {
      if (!clientName) {
        return res.status(400).json({ 
          success: false, 
          error: 'Either event ID or client name is required for rescheduling' 
        });
      }
      
      // Try to find the event by client name
      const foundEvent = await findEventByClientName(
        calendar, 
        calendarId, 
        clientName, 
        null // Don't use startDateTime for search as we're changing it
      );
      
      if (!foundEvent) {
        return res.status(404).json({
          success: false,
          error: `No matching event found for client "${clientName}"`
        });
      }
      
      eventId = foundEvent.id;
      existingEvent = { data: foundEvent };
      console.log(`Found event to reschedule: ${eventId} (${foundEvent.summary})`);
    } else {
      // Get the existing event details
      try {
        existingEvent = await calendar.events.get({
          calendarId: calendarId,
          eventId: eventId
        });
      } catch (getErr) {
        if (getErr.response && getErr.response.status === 404) {
          return res.status(404).json({
            success: false,
            error: 'Event not found with the provided ID'
          });
        }
        throw getErr;
      }
    }
    
    let eventDuration = duration;
    if (existingEvent && existingEvent.data) {
      const originalStart = new Date(existingEvent.data.start.dateTime);
      const originalEnd = new Date(existingEvent.data.end.dateTime);
      // Calculate actual duration in milliseconds, then convert to minutes
      const originalDuration = (originalEnd - originalStart) / (1000 * 60);
      
      // Use the original duration if available, otherwise use the provided duration
      eventDuration = originalDuration || duration;
      
      console.log(`Original event duration: ${eventDuration} minutes`);
    }
    
    const startTime = parsePacificDateTime(newStartDateTime);
    const endTime = new Date(startTime.getTime() + (eventDuration * 60000));

    // Prepare updated event details - keep everything except the times
    const updatedEvent = {
      ...existingEvent.data,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: 'America/Los_Angeles'
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: 'America/Los_Angeles'
      }
    };
    
    // Update the event
    const result = await calendar.events.update({
      calendarId: calendarId,
      eventId: eventId,
      resource: updatedEvent,
      sendUpdates: 'all' // Send update notifications
    });
    
    // Update appointment in database if needed
    // Implement database update logic here
    
    return res.status(200).json({
      success: true,
      action: 'reschedule',
      eventId: result.data.id,
      eventLink: result.data.htmlLink,
      message: 'Appointment successfully rescheduled'
    });
  } catch (error) {
    console.error('Error rescheduling event:', error);
    throw error; // Re-throw for the main error handler
  }
}

module.exports = router;