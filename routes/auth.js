const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { barberOps } = require('../utils/supabase');

// Set up OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// Google login route
router.get('/auth/google', (req, res) => {
  // Store phone number in session if provided
  if (req.query.phone) {
    req.session.phoneNumber = req.query.phone;
  }

  // Generate authentication URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
      'profile',
      'email'
    ],
    prompt: 'consent' // Force to get refresh token
  });

  res.redirect(authUrl);
});

// Callback route after Google authentication
router.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  
  try {
    // Exchange authorization code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // Get user profile information
    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: 'v2'
    });
    
    const { data } = await oauth2.userinfo.get();
    
    // Get list of calendars for selection
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarList = await calendar.calendarList.list();
    
    // Store user information in session
    req.session.email = data.email;
    req.session.refreshToken = tokens.refresh_token;
    req.session.calendars = calendarList.data.items.map(cal => ({
      id: cal.id,
      summary: cal.summary
    }));
    
    // If we have a phone number in session, we can pre-link the account
    if (req.session.phoneNumber) {
      // Use the name from the registration form (stored in session) instead of Google account
      const barberName = req.session.barberName || data.name;
      
      // Update or create barber record in Supabase
      await barberOps.updateOrCreate({
        phone_number: req.session.phoneNumber,
        name: barberName,
        email: data.email,
        refresh_token: tokens.refresh_token
      });
    } else {
      // Display a message that phone number is required
      return res.render('error', { 
        message: 'Phone number is required for registration. Please start again with a phone number.' 
      });
    }
    
    // Redirect to calendar selection page
    res.redirect('/select-calendar');
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.render('error', { message: 'Authentication failed. Please try again.' });
  }
});

// Calendar selection page
router.get('/select-calendar', (req, res) => {
  if (!req.session.calendars || !req.session.phoneNumber) {
    return res.redirect('/auth/google');
  }
  
  res.render('select-calendar', { 
    calendars: req.session.calendars,
    phoneNumber: req.session.phoneNumber
  });
});

// Save selected calendar
router.post('/save-calendar', async (req, res) => {
  const { calendarId } = req.body;
  const phoneNumber = req.session.phoneNumber;
  
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  
  try {
    // Update barber's selected calendar in Supabase
    const updatedBarber = await barberOps.updateCalendarId(phoneNumber, calendarId);
    
    if (!updatedBarber) {
      return res.status(404).json({ error: 'Barber not found' });
    }
    
    // Render success page
    res.render('success');
    
  } catch (error) {
    console.error('Save calendar error:', error);
    res.status(500).json({ error: 'Failed to save calendar preference' });
  }
});

// Manual registration form route
router.get('/register', (req, res) => {
  res.render('register');
});

// Handle manual registration
router.post('/register', async (req, res) => {
  let { name, phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.render('error', { message: 'Phone number is required' });
  }
  
  // Ensure phone number has +1 prefix for US numbers
  phoneNumber = phoneNumber.replace(/\D/g, '');
  if (phoneNumber.length === 10) {
    phoneNumber = '+1' + phoneNumber;
  } else if (!phoneNumber.startsWith('+')) {
    phoneNumber = '+' + phoneNumber;
  }
  
  try {
    // Store both phone and name in session
    req.session.phoneNumber = phoneNumber;
    req.session.barberName = name;
    
    // Pre-create a barber record with minimal info
    await barberOps.updateOrCreate({
      phone_number: phoneNumber,
      name: name
    });
    
    res.redirect('/auth/google');
  } catch (error) {
    console.error('Registration error:', error);
    res.render('error', { message: 'Registration failed. Please try again.' });
  }
});

module.exports = router;