const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { barberOps, clientOps, appointmentOps, supabase } = require('../utils/supabase');

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

router.post('/client-appointment', async (req, res) => {
  let { clientPhone, clientName = "New Client", serviceType = 'Appointment', startDateTime, newStartDateTime, duration = 30, notes = '', preferredBarberId, isCancelling = false, isRescheduling = false, eventId } = req.body;
  if (typeof isCancelling === 'string') isCancelling = isCancelling.toLowerCase() === 'true';
  if (typeof isRescheduling === 'string') isRescheduling = isRescheduling.toLowerCase() === 'true';
  if (typeof duration === 'string') duration = parseInt(duration, 10) || 30;
  if (!clientPhone) return res.status(400).json({ success: false, error: 'Client phone number is required' });
  try {
    let client = await clientOps.getByPhoneNumber(clientPhone);
    if (!client && !isCancelling && preferredBarberId) {
      client = await clientOps.createOrUpdate({ phone_number: clientPhone, name: clientName, preferred_barber_id: preferredBarberId });
    }
    if (!preferredBarberId && (!client || !client.preferred_barber_id)) return res.status(400).json({ success: false, error: 'No barber specified and client has no preferred barber' });
    const barberId = preferredBarberId || client?.preferred_barber_id;
    const { data: barber } = await supabase.from('barbers').select('*').eq('id', barberId).single();
    if (!barber?.refresh_token) return res.status(404).json({ success: false, error: 'Barber not found or not authorized' });
    const oauth2Client = createOAuth2Client(barber.refresh_token);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = barber.selected_calendar_id || 'primary';
    return await handleCreateClientAppointment(calendar, calendarId, { clientPhone, clientName, serviceType, startDateTime, duration, notes, barberId: barber.id }, res);
  } catch (e) {
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

module.exports = router;
