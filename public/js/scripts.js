/**
 * Client-side JavaScript for Barber Calendar Integration
 */

document.addEventListener('DOMContentLoaded', () => {
  // Phone number input formatting
  const phoneInput = document.getElementById('phoneNumber');
  if (phoneInput) {
    phoneInput.addEventListener('input', (e) => {
      // Just keep digits only
      let value = e.target.value.replace(/\D/g, '');
      e.target.value = value;
    });
    
    // On form submit, format the number with +1
    phoneInput.closest('form')?.addEventListener('submit', (e) => {
      e.preventDefault(); // Prevent default submission to handle formatting first
      
      let value = phoneInput.value.replace(/\D/g, '');
      // If US number without country code (10 digits)
      if (value.length === 10) {
        phoneInput.value = '+1' + value;
      } else if (value.length > 0 && !value.startsWith('+')) {
        // Add + for any other number without it
        phoneInput.value = '+' + value;
      }
      
      // Now manually submit the form
      phoneInput.closest('form').submit();
    });
  }

  // Calendar selection functionality
  const calendarOptions = document.querySelectorAll('.calendar-option');
  if (calendarOptions.length > 0) {
    calendarOptions.forEach(option => {
      option.addEventListener('click', function() {
        const radioInput = this.querySelector('input[type="radio"]');
        radioInput.checked = true;
        
        // Update visual selection
        document.querySelectorAll('.calendar-option').forEach(opt => {
          opt.classList.remove('selected');
        });
        this.classList.add('selected');
      });
      
      // Initialize selected state
      const radioInput = option.querySelector('input[type="radio"]');
      if (radioInput && radioInput.checked) {
        option.classList.add('selected');
      }
    });
  }

  // Form validation
  const forms = document.querySelectorAll('form');
  if (forms.length > 0) {
    forms.forEach(form => {
      form.addEventListener('submit', (e) => {
        if (!form.checkValidity()) {
          e.preventDefault();
          e.stopPropagation();
        }
        form.classList.add('was-validated');
      });
    });
  }
});