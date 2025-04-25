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
  },

  async getAllBarbers() {
    const { data, error } = await supabase
      .from('barbers')
      .select('id, name')
      .order('name', { ascending: true });
      
    if (error) {
      console.error('Error fetching all barbers:', error);
      return [];
    }
    
    return data;
  },
  
  async getFirstWithRefreshToken() {
    const { data, error } = await supabase
      .from('barbers')
      .select('*')
      .not('refresh_token', 'is', null)
      .limit(1);
      
    if (error) {
      console.error('Error fetching barber with refresh token:', error);
      return { data: null, error };
    }
    
    return { data: data[0], error: null };
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
  },

  async updatePreferredBarber(clientPhone, preferredBarberId) {
    const { data, error } = await supabase
      .from('clients')
      .update({
        preferred_barber_id: preferredBarberId,
        updated_at: new Date()
      })
      .eq('phone_number', clientPhone)
      .select();
      
    if (error) {
      console.error('Error updating client preferred barber:', error);
      return null;
    }
    
    return data[0];
  },

  async createOrUpdate(clientData) {
    const { 
      phone_number, 
      name, 
      email, 
      preferred_barber_id 
    } = clientData;
    
    // Check if client exists
    const existingClient = await this.getByPhoneNumber(phone_number);
    
    if (existingClient) {
      // Update existing client
      const { data, error } = await supabase
        .from('clients')
        .update({
          name: name || existingClient.name,
          email: email || existingClient.email,
          preferred_barber_id: preferred_barber_id || existingClient.preferred_barber_id,
          updated_at: new Date()
        })
        .eq('phone_number', phone_number)
        .select();
        
      if (error) {
        console.error('Error updating client:', error);
        return null;
      }
      
      return data[0];
    } else {
      // Create new client
      const { data, error } = await supabase
        .from('clients')
        .insert({
          phone_number,
          name: name || 'New Client',
          email,
          preferred_barber_id
        })
        .select();
        
      if (error) {
        console.error('Error creating client:', error);
        return null;
      }
      
      return data[0];
    }
  }
};

// Appointment operations
const appointmentOps = {
  // Keep your existing methods
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
  },
  
  // Add this new method for updating appointments
  async updateByEventId(eventId, updateData) {
    console.log(`Attempting to update appointment with event ID: ${eventId}`);
    console.log('Update data:', updateData);
    
    const { data, error } = await supabase
      .from('appointments')
      .update({
        ...updateData,
        updated_at: new Date()
      })
      .eq('google_calendar_event_id', eventId)
      .select();
      
    if (error) {
      console.error('Error updating appointment:', error);
      return { success: false, error };
    }
    
    if (data && data.length === 0) {
      console.warn(`No appointment found with event ID: ${eventId}`);
      return { success: false, message: 'No matching appointment found' };
    }
    
    console.log('Successfully updated appointment:', data);
    return { success: true, data: data[0] };
  },
  
  // Add this method to find appointments by client phone and date range
  async findByClientPhone(clientPhone, startTimeRange) {
    let query = supabase
      .from('appointments')
      .select('*')
      .eq('client_phone', clientPhone);
    
    // If start time range is provided, filter by that too
    if (startTimeRange) {
      const { startBefore, startAfter } = startTimeRange;
      
      if (startBefore) {
        query = query.lt('start_time', startBefore);
      }
      
      if (startAfter) {
        query = query.gt('start_time', startAfter);
      }
    }
    
    const { data, error } = await query;
    
    if (error) {
      console.error('Error finding appointments:', error);
      return [];
    }
    
    return data;
  }
};

const bookingStateOps = {
  async updateBookingState(clientPhone, stateData) {
    const { status, appointmentDetails = null } = stateData;
    
    if (!clientPhone || !status) {
      console.error('Missing required parameters for updating booking state');
      return null;
    }
    
    // Check if client exists
    const existingClient = await clientOps.getByPhoneNumber(clientPhone);
    
    if (!existingClient) {
      console.error(`Client with phone ${clientPhone} not found`);
      return null;
    }
    
    // Get current booking state
    const currentState = existingClient.last_booking_state || {
      status: 'not_started',
      appointmentDetails: null,
      lastUpdated: null
    };
    
    // Prepare updated state
    const updatedState = {
      status,
      appointmentDetails: appointmentDetails || currentState.appointmentDetails,
      lastUpdated: new Date().toISOString()
    };
    
    // Update client record
    const { data, error } = await supabase
      .from('clients')
      .update({ 
        last_booking_state: updatedState,
        updated_at: new Date()
      })
      .eq('phone_number', clientPhone)
      .select();
      
    if (error) {
      console.error('Error updating booking state:', error);
      return null;
    }
    
    return data[0];
  },
  
  async getBookingState(clientPhone) {
    if (!clientPhone) {
      console.error('Client phone number is required');
      return null;
    }
    
    const existingClient = await clientOps.getByPhoneNumber(clientPhone);
    
    if (!existingClient) {
      return null;
    }
    
    return existingClient.last_booking_state || {
      status: 'not_started',
      appointmentDetails: null,
      lastUpdated: null
    };
  }
};

const conversationOps = {
  async getOrCreateSession(phoneNumber) {
    // Check if session exists
    let { data: session, error } = await supabase
      .from('conversation_sessions')
      .select('*')
      .eq('phone_number', phoneNumber)
      .single();
    
    if (error && error.code === 'PGRST116') {
      // Session doesn't exist, create it
      const { data: newSession, error: createError } = await supabase
        .from('conversation_sessions')
        .insert({ phone_number: phoneNumber })
        .select()
        .single();
      
      if (createError) {
        console.error('Error creating session:', createError);
        return null;
      }
      session = newSession;
    }
    
    // Update last_active
    await supabase
      .from('conversation_sessions')
      .update({ last_active: new Date() })
      .eq('id', session.id);
    
    return session;
  },

  async addMessage(sessionId, role, content, metadata = null) {
    const { data, error } = await supabase
      .from('conversation_messages')
      .insert({
        session_id: sessionId,
        role,
        content,
        metadata
      })
      .select();
    
    if (error) {
      console.error('Error adding message:', error);
      return null;
    }
    
    return data[0];
  },

  async getConversationHistory(phoneNumber, limit = 10) {
    // Get session
    const session = await this.getOrCreateSession(phoneNumber);
    if (!session) return [];
    
    // Get messages
    const { data, error } = await supabase
      .from('conversation_messages')
      .select('*')
      .eq('session_id', session.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) {
      console.error('Error fetching conversation history:', error);
      return [];
    }
    
    // Return messages in chronological order
    return data.reverse();
  },

  async clearSession(phoneNumber) {
    const session = await this.getOrCreateSession(phoneNumber);
    if (!session) return false;
    
    const { error } = await supabase
      .from('conversation_messages')
      .delete()
      .eq('session_id', session.id);
    
    if (error) {
      console.error('Error clearing session:', error);
      return false;
    }
    
    return true;
  }
};

// Export the new operations
module.exports = {
  supabase,
  barberOps,
  clientOps,
  appointmentOps,
  bookingStateOps,
  conversationOps  // Add this
};