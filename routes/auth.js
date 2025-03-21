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
      'https://www.googleapis.com/auth/forms',  // Add Forms API scope
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
      const barber = await barberOps.updateOrCreate({
        phone_number: req.session.phoneNumber,
        name: barberName,
        email: data.email,
        refresh_token: tokens.refresh_token
      });
      
      // After creating/updating a barber, update the form dropdown
      if (barber && process.env.GOOGLE_FORM_ID && process.env.GOOGLE_FORM_BARBER_QUESTION_ID) {
        try {
          await updateFormBarberDropdown(tokens.refresh_token);
        } catch (formError) {
          console.error('Failed to update form dropdown:', formError);
          // Non-critical error, continue with registration
        }
      }
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

// New function to update the form dropdown
async function updateFormBarberDropdown(refreshToken) {
  try {
    // Create new OAuth client with the refresh token
    const formOAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.REDIRECT_URI
    );
    
    formOAuth2Client.setCredentials({
      refresh_token: refreshToken
    });
    
    // Create Forms API client
    const forms = google.forms({
      version: 'v1',
      auth: formOAuth2Client
    });
    
    // Get all barbers from database
    const allBarbers = await barberOps.getAllBarbers();
    
    if (!allBarbers || allBarbers.length === 0) {
      console.log('No barbers found to update form dropdown');
      return;
    }
    
    // Get current form structure
    const form = await forms.forms.get({
      formId: process.env.GOOGLE_FORM_ID
    });
    
    // Find the target question (barber selection dropdown) by looking for the first dropdown in the form
    // or you could search by title if your dropdown has a specific title
    const targetQuestion = form.data.items.find(item => 
      item.questionItem && 
      item.questionItem.question.choiceQuestion &&
      item.questionItem.question.choiceQuestion.type === 'DROP_DOWN'
    );
    
    if (!targetQuestion) {
      console.error('Target question not found in form');
      return;
    }
    
    // Prepare barber names for dropdown
    const barberNames = allBarbers.map(barber => barber.name).sort();
    
    // Update the dropdown options
    const updateRequest = {
      requests: [{
        updateItem: {
          item: {
            itemId: targetQuestion.itemId,
            questionItem: {
              question: {
                questionId: targetQuestion.questionItem.question.questionId,
                choiceQuestion: {
                  type: 'DROP_DOWN',
                  options: barberNames.map(name => ({
                    value: name
                  }))
                }
              }
            }
          },
          location: {
            index: targetQuestion.location.index
          },
          updateMask: 'questionItem.question.choiceQuestion.options'
        }
      }]
    };
    
    // Perform the update
    await forms.forms.batchUpdate({
      formId: process.env.GOOGLE_FORM_ID,
      requestBody: updateRequest
    });
    
    console.log('Successfully updated form dropdown with barbers:', barberNames);
    return true;
  } catch (error) {
    console.error('Error updating form dropdown:', error);
    throw error;
  }
}

// Add method to get form structure (useful for setup)
router.get('/get-form-info', async (req, res) => {
  // Only allow in development mode
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).send('This endpoint is only available in development mode');
  }
  
  const { formId } = req.query;
  
  if (!formId) {
    return res.status(400).send('Form ID is required');
  }
  
  try {
    // Get a refresh token from a barber (could also use admin token)
    const { data: barber } = await barberOps.getFirstWithRefreshToken();
    
    if (!barber || !barber.refresh_token) {
      return res.status(404).send('No barber with refresh token found');
    }
    
    // Set up OAuth client with the refresh token
    const formOAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.REDIRECT_URI
    );
    
    formOAuth2Client.setCredentials({
      refresh_token: barber.refresh_token
    });
    
    // Create Forms API client
    const forms = google.forms({
      version: 'v1',
      auth: formOAuth2Client
    });
    
    // Get form structure
    const form = await forms.forms.get({
      formId: formId
    });
    
    // Format the response to highlight questions and IDs
    const formattedQuestions = form.data.items
      .filter(item => item.questionItem)
      .map(item => {
        const question = item.questionItem.question;
        let type = 'Unknown';
        
        if (question.textQuestion) type = 'Text';
        if (question.choiceQuestion) {
          if (question.choiceQuestion.type === 'DROP_DOWN') type = 'Dropdown';
          if (question.choiceQuestion.type === 'RADIO') type = 'Multiple Choice';
          if (question.choiceQuestion.type === 'CHECKBOX') type = 'Checkboxes';
          type = question.choiceQuestion.type || type;
        }
        
        return {
          title: item.title,
          questionId: question.questionId,
          type: type,
          itemId: item.itemId,
          index: item.location.index
        };
      });
    
    res.json({
      formId: form.data.formId,
      title: form.data.info.title,
      questions: formattedQuestions
    });
  } catch (error) {
    console.error('Error getting form info:', error);
    res.status(500).send(`Error getting form info: ${error.message}`);
  }
});

// Add method to manually update form dropdown
router.post('/update-form-dropdown', async (req, res) => {
  const { formId } = req.body;
  
  if (!formId) {
    return res.status(400).json({
      success: false,
      error: 'Form ID is required'
    });
  }
  
  try {
    // Get a refresh token from a barber (could also use admin token)
    const { data: barber } = await barberOps.getFirstWithRefreshToken();
    
    if (!barber || !barber.refresh_token) {
      return res.status(404).json({
        success: false,
        error: 'No barber with refresh token found'
      });
    }
    
    await updateFormBarberDropdown(barber.refresh_token);
    
    return res.status(200).json({
      success: true,
      message: 'Form dropdown updated successfully'
    });
  } catch (error) {
    console.error('Manual form update error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
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