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
    eventId // Required for cancel/reschedule
  } = req.body;
  
  console.log('Webhook received:', { action, phoneNumber, startDateTime, clientName });
  
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
        return await handleCancelEvent(calendar, calendarId, eventId, res);
      
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
    resource: eventDetails
  });
  
  // Store appointment in database
  if (event.data && event.data.id) {
    // Use client's name if provided
    await appointmentOps.create({
      client_phone: clientName ? clientName : 'Unknown',
      barber_id: barber.id,
      service_type: service,
      start_time: startTimeIso,
      end_time: endTimeIso,
      google_calendar_event_id: event.data.id,
      notes: notes || ''
    });
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
async function handleCancelEvent(calendar, calendarId, eventId, res) {
  if (!eventId) {
    return res.status(400).json({ 
      success: false, 
      error: 'Event ID is required for cancelling events' 
    });
  }
  
  try {
    // First try to find the event
    await calendar.events.get({
      calendarId: calendarId,
      eventId: eventId
    });
    
    // Event exists, delete it
    await calendar.events.delete({
      calendarId: calendarId,
      eventId: eventId,
      sendUpdates: 'all' // Send update notifications
    });
    
    // Update appointment status in database
    // This would typically update the 'status' field to 'cancelled'
    // Implement database update logic here if needed
    
    return res.status(200).json({
      success: true,
      action: 'cancel',
      message: 'Appointment successfully cancelled'
    });
  } catch (error) {
    // Handle case where event doesn't exist
    if (error.response && error.response.status === 404) {
      return res.status(404).json({
        success: false,
        error: 'Event not found'
      });
    }
    
    throw error; // Re-throw for the main error handler
  }
}

// Helper function to reschedule an event
async function handleRescheduleEvent(calendar, calendarId, eventId, data, res) {
  const { startDateTime, duration = 30 } = data;
  
  if (!eventId || !startDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'Event ID and new start date-time are required for rescheduling' 
    });
  }
  
  try {
    // First get the existing event
    const existingEvent = await calendar.events.get({
      calendarId: calendarId,
      eventId: eventId
    });
    
    // Parse new dates
    const startTime = new Date(startDateTime);
    const endTime = new Date(startTime.getTime() + (duration * 60000));
    
    // Prepare updated event details
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
    
    // Update appointment in database
    // Implement database update logic here if needed
    
    return res.status(200).json({
      success: true,
      action: 'reschedule',
      eventId: result.data.id,
      eventLink: result.data.htmlLink,
      message: 'Appointment successfully rescheduled'
    });
  } catch (error) {
    // Handle case where event doesn't exist
    if (error.response && error.response.status === 404) {
      return res.status(404).json({
        success: false,
        error: 'Event not found'
      });
    }
    
    throw error; // Re-throw for the main error handler
  }
}

module.exports = router;