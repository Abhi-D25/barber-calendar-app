const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { barberOps, clientOps, appointmentOps } = require('../utils/supabase');

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
  // Default search window if no date provided: 2 weeks from now
  let timeMin, timeMax;
  
  if (appointmentDate) {
    // Search window: 24 hours before and after the appointment date
    timeMin = new Date(appointmentDate);
    timeMin.setHours(timeMin.getHours() - 24);
    
    timeMax = new Date(appointmentDate);
    timeMax.setHours(timeMax.getHours() + 24);
  } else {
    // If no date hint, search from today to 2 weeks ahead
    timeMin = new Date();
    timeMax = new Date();
    timeMax.setDate(timeMax.getDate() + 14);
  }
  
  console.log(`Searching for event with client: ${clientName}, between ${timeMin.toISOString()} and ${timeMax.toISOString()}`);
  
  // Search for events containing the client name
  const response = await calendar.events.list({
    calendarId: calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    q: clientName,  // Search text
    singleEvents: true,
    orderBy: 'startTime'
  });
  
  console.log(`Found ${response.data.items.length} potential matching events`);
  
  // Return the first matching event, or null if none found
  return response.data.items.length > 0 ? response.data.items[0] : null;
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

// Helper function to create a new event
async function handleCreateEvent(calendar, calendarId, data, barber, res) {
  const { startDateTime, clientName, duration, service, notes } = data;
  
  if (!startDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'Start date-time is required for creating events' 
    });
  }
  
  // Parse dates
  const startTime = new Date(startDateTime);
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
    
    // Parse new dates
    const startTime = new Date(startDateTime);
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