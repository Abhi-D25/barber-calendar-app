const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Create Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Barber operations
const barberOps = {
  async getByPhoneNumber(phoneNumber) {
    const { data, error } = await supabase
      .from('barbers')
      .select('*')
      .eq('phone_number', phoneNumber)
      .single();
      
    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching barber:', error);
    }
    return data;
  },
  
  async updateOrCreate(barberData) {
    const { phone_number, name, email, refresh_token, selected_calendar_id } = barberData;
    
    // Check if barber exists
    const existingBarber = await this.getByPhoneNumber(phone_number);
    
    if (existingBarber) {
      // Update existing barber
      const { data, error } = await supabase
        .from('barbers')
        .update({
          name: name || existingBarber.name,
          email: email || existingBarber.email,
          refresh_token: refresh_token || existingBarber.refresh_token,
          selected_calendar_id: selected_calendar_id || existingBarber.selected_calendar_id,
          updated_at: new Date()
        })
        .eq('phone_number', phone_number)
        .select();
        
      if (error) {
        console.error('Error updating barber:', error);
        return null;
      }
      
      return data[0];
    } else {
      // Create new barber
      const { data, error } = await supabase
        .from('barbers')
        .insert({
          phone_number,
          name: name || 'New Barber',
          email,
          refresh_token,
          selected_calendar_id: selected_calendar_id || 'primary'
        })
        .select();
        
      if (error) {
        console.error('Error creating barber:', error);
        return null;
      }
      
      return data[0];
    }
  },
  
  async updateCalendarId(phoneNumber, calendarId) {
    const { data, error } = await supabase
      .from('barbers')
      .update({
        selected_calendar_id: calendarId,
        updated_at: new Date()
      })
      .eq('phone_number', phoneNumber)
      .select();
      
    if (error) {
      console.error('Error updating calendar ID:', error);
      return null;
    }
    
    return data[0];
  }
};

// Client operations
const clientOps = {
  async getByPhoneNumber(phoneNumber) {
    const { data, error } = await supabase
      .from('clients')
      .select(`
        *,
        preferred_barber:barbers(id, name, phone_number)
      `)
      .eq('phone_number', phoneNumber)
      .single();
      
    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching client:', error);
    }
    return data;
  }
};

// Appointment operations
const appointmentOps = {
  async create(appointmentData) {
    const { 
      client_phone, 
      barber_id, 
      service_type, 
      start_time, 
      end_time, 
      google_calendar_event_id,
      notes 
    } = appointmentData;
    
    const { data, error } = await supabase
      .from('appointments')
      .insert({
        client_phone,
        barber_id,
        service_type,
        start_time,
        end_time,
        google_calendar_event_id,
        notes
      })
      .select();
      
    if (error) {
      console.error('Error creating appointment:', error);
      return null;
    }
    
    return data[0];
  }
};

module.exports = {
  supabase,
  barberOps,
  clientOps,
  appointmentOps
};