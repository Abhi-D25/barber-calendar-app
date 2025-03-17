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

// Zapier webhook endpoint to create calendar events
router.post('/create-event', async (req, res) => {
  const { 
    phoneNumber, 
    startDateTime,  // Use the ISO format directly
    clientName,
    duration = 30,  // Default to 30 minutes if not specified
    service,
    notes
  } = req.body;
  
  if (!phoneNumber || !startDateTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number and start date-time are required' 
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
    
    // Parse the ISO date string to get start time
    const startTime = new Date(startDateTime);
    
    // Calculate end time based on duration (in minutes)
    const endTime = new Date(startTime.getTime() + (duration * 60000));
    
    // Format as ISO strings for Google Calendar
    const startTimeIso = startTime.toISOString();
    const endTimeIso = endTime.toISOString();
    
    // Prepare event details
    const eventSummary = clientName 
      ? `${service || 'Appointment'}: ${clientName}`
      : `${service || 'Appointment'}`;
      
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
    
    // Create event in the selected calendar
    const calendarId = barber.selected_calendar_id || 'primary';
    const event = await calendar.events.insert({
      calendarId: calendarId,
      resource: eventDetails
    });
    
    // Store appointment in database
    if (event.data && event.data.id) {
      // Use client phone if provided, otherwise use a placeholder
      const clientPhoneNumber = clientPhone || phoneNumber;
      
      // Store the appointment
      await appointmentOps.create({
        client_phone: clientPhoneNumber,
        barber_id: barber.id,
        service_type: service || 'appointment',
        start_time: startTimeIso,
        end_time: endTimeIso,
        google_calendar_event_id: event.data.id,
        notes: notes || ''
      });
    }
    
    // Return success response
    res.status(200).json({
      success: true,
      eventId: event.data.id,
      eventLink: event.data.htmlLink,
      message: 'Appointment added to calendar'
    });
    
  } catch (error) {
    console.error('Create event error:', error);
    
    // Return detailed error for debugging
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || 'Unknown error'
    });
  }
});

module.exports = router;