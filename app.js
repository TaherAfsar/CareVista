const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const serviceAccount = require('./serviceAccountKey.json');
const admin = require('firebase-admin');
const session = require('express-session');
const bodyParser = require('body-parser');
const pdf = require('html-pdf'); // Import html-pdf library
const ejs = require('ejs');
const path = require('path'); // Import the path module
const fs = require('fs');
const nodemailer = require('nodemailer');
app.use(express.static('public'))
const Jimp = require('jimp');
const qrCodeReader = require('qrcode-reader');
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI("GEMINI API HERE");

// Initialize Firebase Admin SDK
const firebaseApp = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Initialize Firestore
const firestore = firebaseApp.firestore();

app.use(session({
    secret: 'SESSION SECRET KEY HERE',
    resave: false,
    saveUninitialized: true
}));
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
// Set EJS as the view engine
app.set('view engine', 'ejs');



const transporter = nodemailer.createTransport({
    // Set your email service provider details here (e.g., Gmail)
    service: 'gmail',
    auth: {
      user: 'EMAIL HERE',
      pass: 'EMAIL PASSWORD HERE'
    }
  });



// Routes

// Middleware
// Define a middleware to check if the doctor is authenticated
const requireAuth = (req, res, next) => {
    if (!req.session.doctor) {
        // If the doctor is not in session, redirect to the login page
        return res.redirect('/login');
    }
    // If the doctor is authenticated, proceed to the next middleware
    next();
};




// 
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // Query the doctor document based on the provided email
        const doctorSnapshot = await firestore.collection('doctors').where('email', '==', email).get();

        if (doctorSnapshot.empty) {
            // No doctor found with the provided email
            return res.redirect('/login?error=invalid');
        }

        // Get the first doctor document
        const doctor = doctorSnapshot.docs[0].data();

        // Check if the provided password matches the stored password
        if (doctor.password === password) {
            // If authentication is successful, redirect to the dashboard
            req.session.doctor = doctor; // Store user data in the session
            return res.redirect('/');
        } else {
            // If authentication fails, redirect back to the login page with an error message
            return res.redirect('/login?error=invalid');
        }
    } catch (error) {
        console.error('Error during login: ', error);
        // Redirect back to the login page with an error message
        return res.redirect('/login?error=unknown');
    }
});

// Define a route to render an EJS view
app.get('/', requireAuth, (req, res) => {
    console.log(req.session.doctor);
    res.render('index', { message: 'Hello, world!' ,doctor: req.session.doctor });
});

// Define a route to render the login page
app.get('/login', (req, res) => {
    res.render('login', { message: null }); // Pass any additional data needed by the view
});

// Logout route
app.get('/logout', (req, res) => {
    // Destroy the session
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.redirect('/'); // Redirect to home page or login page
        }
        // Redirect to the login page after successful logout
        res.redirect('/login');
    });
});


// Waiting list
// Define a route to display bookings in the waiting list
app.get('/waiting-list', requireAuth, async (req, res) => {
    try {
        // Get the doctor object from the session
        const doctor = req.session.doctor;

        // Array to store booking details
        const waitingListBookings = [];

        // Iterate through the waiting list array
        for (const patientId of doctor.WaitingList) {
            // Query the booking document based on the booking ID
            const bookingSnapshot = await firestore.collection('patients').doc(patientId).get();

            if (bookingSnapshot.exists) {
                // If the booking exists, add its details to the array
                waitingListBookings.push(bookingSnapshot.data());
            } else {
                console.log(`Booking with ID ${patientId} not found.`);
            }
        }
        console.log(waitingListBookings);
        // Render the waiting list page with the booking details
        res.render('waiting-list', { doctor: doctor, bookings: waitingListBookings });
    } catch (error) {
        console.error('Error fetching waiting list bookings: ', error);
        // Render an error page if there's an error
        res.render('error', { message: 'Error fetching waiting list bookings' });
    }
});

// Define a route to generate an invoice
app.get('/invoice/:bookingId', requireAuth, async (req, res) => {
    const doctor = req.session.doctor;
    try {
        // Extract the booking ID from the request parameters
        const bookingId = req.params.bookingId;

        // Query Firestore to get the booking details
        const bookingDoc = await firestore.collection('bookings').doc(bookingId).get();

        // Check if the booking exists
        if (!bookingDoc.exists) {
            return res.status(404).send('Booking not found');
        }

        // Extract booking data
        const bookingData = bookingDoc.data();

        // Calculate total price based on the services provided in the booking
        // For simplicity, let's assume the price is fixed per booking
        const totalPrice = bookingData.fees;

        // Render the invoice template with booking details and total price
        res.render('invoice', { booking: bookingData, totalPrice,doctor,bookingId });
    } catch (error) {
        console.error('Error generating invoice: ', error);
        // Render an error page if there's an error
        res.status(500).send('Error generating invoice');
    }
});

app.post('/download-invoice/:bookingId', requireAuth, async (req, res) => {
    try {
        // Retrieve booking ID from request parameters
        const bookingId = req.params.bookingId;
        const doctor = req.session.doctor;

        // Retrieve booking details from Firestore
        const bookingDoc = await firestore.collection('bookings').doc(bookingId).get();

        // Check if booking exists
        if (!bookingDoc.exists) {
            return res.status(404).send('Booking not found');
        }

        // Retrieve booking data
        const bookingData = bookingDoc.data();

        // Render invoice template with booking details
        const invoicePath = path.join(__dirname, 'views', 'invoice.ejs');
        
        // Render the HTML content using ejs.renderFile
        const html = await ejs.renderFile(invoicePath, { booking: bookingData, totalPrice: bookingData.price, doctor, bookingId });

        // Define the path for the temporary HTML file
        const tempHtmlPath = path.join(__dirname, 'temp.html');
        
        // Write the rendered HTML content to the temporary HTML file
        fs.writeFileSync(tempHtmlPath, html);

        // Read the HTML content from the temporary HTML file synchronously
        const renderedHtml = fs.readFileSync(tempHtmlPath, 'utf8');

        // Define options for PDF creation
        const options = { format: 'Letter' }; // Adjust options as needed

        // Generate the PDF using html-pdf
        pdf.create(renderedHtml, options).toFile('./invoice.pdf', function(err, res) {
            if (err) {
                console.error('Error creating PDF:', err);
            } else {
                // return res.redirect(`/invoice/${bookingId}`,{booking: bookingData, totalPrice: bookingData.price, doctor, bookingId})
                console.log('PDF created successfully:', res);
            }

            // Remove the temporary HTML file
            fs.unlinkSync(tempHtmlPath);
        });

            // Configure nodemailer transporter
    const transporter = nodemailer.createTransport({
        // Set your email service provider details here (e.g., Gmail)
        service: 'gmail',
        auth: {
          user: 'EMAIL ID HERE',
          pass: 'EMAIL PASS HERE'
        }
      });
  
      // Compose email options
      const mailOptions = {
        from: 'YOUR EMAIL HERE',
        to: patient.email,
        subject: 'Invoice for Booking', // Email subject
    text: 'Please find attached the invoice for your booking.', // Email body text
    attachments: [
        {
            filename: 'invoice.pdf', // Name of the attached file
            path: './invoice.pdf' // Path to the generated PDF file
        }
    ]
      };
  
      // Send the email
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.error(error);
          return res.status(500).json({ message: 'Error sending email' });
        }
        console.log(`Email sent: ${info.response}`);
      });
    } catch (error) {
        console.error('Error downloading invoice: ', error);
        res.status(500).send('Error downloading invoice');
    }
});


// view bookings

// Define a route to render the viewBookings page
app.get('/view-bookings', requireAuth, async (req, res) => {
    doctor=req.session.doctor
    try {
        // Fetch bookings from Firestore
        const bookingsSnapshot = await firestore.collection('bookings').get();
        const bookings = [];

        // Iterate through the bookings documents and extract data
        bookingsSnapshot.forEach(doc => {
            const bookingData = doc.data();
            // Push booking data to the array
            bookings.push({
                id: doc.id,
                date: bookingData.date,
                doctorId: bookingData.doctorId,
                startTime: bookingData.startTime,
                endTime: bookingData.endTime,
                patientId: bookingData.patientId,
                fees: bookingData.fees
            });
        });

        // Render the viewBookings page with bookings data
        res.render('viewBooking', { bookings,doctor });
    } catch (error) {
        console.error('Error fetching bookings:', error);
        // Render an error page if there's an error
        res.render('error', { message: 'Error fetching bookings' });
    }
});



// Multer middleware setup for handling image uploads

// Route for uploading and decoding QR code from image
// Configure multer for file uploads
// Multer middleware setup for handling image uploads
const upload = multer({ dest: 'public/uploads/' });

// Route for uploading and decoding QR code from image
app.post('/decode-qr-code', upload.single('image'), async (req, res) => {
    try {
        // Check if file is present in the request
        if (!req.file) {
            return res.status(400).send('No file uploaded');
        }

        // Read the uploaded image using Jimp
        const imagePath = req.file.path;
        const image = await Jimp.read(imagePath);

        // Create an instance of qrcode-reader
        const qrCodeInstance = new qrCodeReader();

        // Define callback function to handle QR code decoding
        qrCodeInstance.callback = async function(err, value) {
            if (err) {
                console.error(err);
                return res.status(500).send('Error decoding QR code');
            }

           // Get the decoded QR code value (object ID)
           const decodedObjectId = value.result;

           try {
                doctor = req.session.doctor
               // Retrieve the doctor's document from Firestore based on the doctor's ID
               const doctorId = doctor; // Replace 'doctorId' with the actual ID of the doctor
               const doctorRef = firestore.collection('doctors').doc(doctor.id);
               const doctorDoc = await doctorRef.get();

               if (!doctorDoc.exists) {
                   return res.status(404).send('Doctor not found');
               }

               // Modify the "waitingList" array to remove the decoded object ID
               const doctorData = doctorDoc.data();
               const updatedWaitingList = doctorData.WaitingList.filter(id => id !== decodedObjectId);

               // Update the doctor's document in Firestore with the modified data
               await doctorRef.update({ WaitingList: updatedWaitingList });

               // Send success response
               res.json({ message: 'Object ID removed from waiting list successfully' });
           } catch (error) {
               console.error('Error updating doctor document:', error);
               res.status(500).send('Error updating doctor document');
           }
       };

       // Decode the QR code from the image
       qrCodeInstance.decode(image.bitmap);
   } catch (error) {
       console.error('Error decoding QR code:', error);
       res.status(500).send('Error decoding QR code');
   }
});

// Start the server

// Scan qr code
app.get('/scan-qr-code', requireAuth, (req, res) => {
    doctor = req.session.doctor
    res.render('scanQR',{doctor:doctor}); // Render the scanQR.ejs view
});



// Booking reminder
// Define the reminder threshold (in milliseconds)
const reminderThreshold = 60 * 60 * 1000; // 1 hour

// Create a function to send reminder emails
// Function to send reminder email
async function sendReminderEmail(email) {
    try {
      // Compose email options
      const mailOptions = {
        from: 'YOUR EMAIL HERE',
        to: email,
        subject: 'Reminder: Your Appointment is Approaching',
        text: 'Your appointment is scheduled within the next half hour. Please make sure to arrive on time.'
      };
  
      // Send email
      const info = await transporter.sendMail(mailOptions);
      console.log(`Reminder email sent to ${email}: ${info.response}`);
    } catch (error) {
      console.error('Error sending reminder email:', error);
    }
  }
  
  
  // Function to fetch upcoming bookings and send reminders
  async function checkAndSendReminders() {
    try {
      // Get current time and calculate threshold time (30 minutes from now)
      const currentTime = new Date();
      const thresholdTime = new Date(currentTime.getTime() + 30 * 60 * 1000);
  
      // Query upcoming bookings
      const bookingsSnapshot = await admin.firestore().collection('bookings')
        .where('startTime', '<=', thresholdTime)
        .where('startTime', '>=', currentTime)
        .get();
  
        const email = patient.email; 
      // Loop through bookings and send reminders
      bookingsSnapshot.forEach(async (doc) => {
        const booking = doc.data();
        await sendReminderEmail(email);
      });
      sendReminderEmail(email);
  
      console.log('Reminder emails sent successfully.');
    } catch (error) {
      console.error('Error fetching or sending reminders:', error);
    }
  }
  
  // Run the function
  checkAndSendReminders();

// Run the function immediately after the server starts
setTimeout(checkAndSendReminders, 2 * 60 * 1000); // Run after 2 minutes

// Run the function every hour
// setInterval(sendReminderEmails, 60*60 ); // 1 hour

// Define a route to send a message to the chatbot
app.post('/chat', async (req, res) => {
    try {
        // Get the doctor object from the session
        const doctor = req.session.doctor;
        // Extract the prompt message from the request body
        const prompt = req.body.prompt;

        // Retrieve data from the bookings collection
        const bookingsSnapshot = await firestore.collection('bookings').get();
        // Retrieve data from the patients collection
        const patientsSnapshot = await firestore.collection('patients').get();

        // Merge data from both collections into a single array
        const mergedData = [];
        bookingsSnapshot.forEach(doc => {
            mergedData.push(JSON.stringify(doc.data()));
        });
        patientsSnapshot.forEach(doc => {
            mergedData.push(JSON.stringify(doc.data()));
        });

        // Concatenate user's message with the prompt
        const concatenatedPrompt = `This is the prompt : ${prompt} from the doctor: ${doctor.name} and this is the data of the doctor and his patients: ${mergedData} based on the data I have provided and the prompt give me an most accurate response you can. remember the answer should take both prompt and the data in respect , also if you are replying with patientId then avoid it and reply with name`;
        console.log(concatenatedPrompt)

        // Get generative model
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });

        // Generate content based on the concatenated prompt and merged data
        const result = await model.generateContent(concatenatedPrompt, mergedData);
        const response = await result.response;
        const text = await response.text();

        // Send the generated response to the doctor
        res.render('chat', { response: { response: text } });
    } catch (error) {
        console.error('Error generating AI response:', error);
        res.status(500).json({ error: 'Error generating AI response' });
    }
});


app.get('/chat', (req, res) => {
    doctor = req.session.doctor;
    res.render('chat', { response: {}, doctor });
});


// Define a route to cancel a booking
app.post('/cancel-booking/:bookingId', requireAuth, async (req, res) => {
    try {
        // Extract the booking ID from the request parameters
        const bookingId = req.params.bookingId;

        // Query Firestore to get the booking document
        const bookingDoc = await firestore.collection('bookings').doc(bookingId).get();

        // Check if the booking exists
        if (!bookingDoc.exists) {
            return res.status(404).send('Booking not found');
        }

        // Retrieve booking data
        const bookingData = bookingDoc.data();

        // Delete the booking document from Firestore
        await firestore.collection('bookings').doc(bookingId).delete();

        // Send cancellation email to the patient
        const patientEmail = patient.email;
        const cancellationEmailOptions = {
            from: 'YOUR EMAIL HERE', // Your email address
            to: patientEmail,
            subject: 'Booking Cancellation Confirmation',
            text: `Opops!! Your booking with ID ${bookingId} has been cancelled.
            Sadly no doctors are available`
        };

        // Send the cancellation email
        await transporter.sendMail(cancellationEmailOptions);

        // Redirect to the view bookings page with a success message
        res.redirect('/view-bookings?success=booking_cancelled');
    } catch (error) {
        console.error('Error cancelling booking:', error);
        // Render an error page if there's an error
        res.render('error', { message: 'Error cancelling booking' });
    }
});


// Start the server
app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});


