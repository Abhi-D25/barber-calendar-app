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
    appointmentDate, 
    appointmentTime, 
    clientName,
    clientPhone,
    service,
    notes
  } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ 
      success: false, 
      error: 'Barber phone number is required' 
    });
  }
  
  if (!appointmentDate || !appointmentTime) {
    return res.status(400).json({ 
      success: false, 
      error: 'Appointment date and time are required' 
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
    
    // Parse appointment date and time
    const [year, month, day] = appointmentDate.split('-').map(num => parseInt(num, 10));
    const [hours, minutes] = appointmentTime.split(':').map(num => parseInt(num, 10));
    
    // Create event start and end times
    // Note: Month in JavaScript Date is 0-indexed (0 = January)
    const startTime = new Date(year, month - 1, day, hours, minutes);
    
    // Default duration: 1 hour, adjust as needed based on service
    let duration = 60; // minutes
    if (service === 'haircut') {
      duration = 30;
    } else if (service === 'hair coloring') {
      duration = 120;
    } else if (service === 'hair styling') {
      duration = 60;
    } else if (service === 'blowout') {
      duration = 45;
    }
    
    const endTime = new Date(startTime.getTime() + duration * 60000);
    
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
        timeZone: 'America/Los_Angeles' // Adjust timezone as needed
      },
      end: {
        dateTime: endTimeIso,
        timeZone: 'America/Los_Angeles' // Adjust timezone as needed
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