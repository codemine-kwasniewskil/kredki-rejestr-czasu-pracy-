const nodemailer = require('nodemailer');

if (!process.env.MAIL_PASSWORD) {
  console.warn('[mailer] MAIL_PASSWORD is not set — emails will not be sent');
}

const transporter = nodemailer.createTransport({
  host: 'serwer2589336.home.pl',
  port: 465,
  secure: true, // SSL on 465
  auth: {
    user: 'hello@graficzek.pl',
    pass: process.env.MAIL_PASSWORD,
  },
  tls: { rejectUnauthorized: false },
});

// Log connection result on startup
transporter.verify().then(() => {
  console.log('[mailer] SMTP connection OK (serwer2589336.home.pl:465)');
}).catch(err => {
  console.error('[mailer] SMTP connection FAILED:', err.message);
});

async function sendMail({ to, subject, html }) {
  if (!process.env.MAIL_PASSWORD) {
    console.warn('[mailer] Skipping email to', to, '— MAIL_PASSWORD not set');
    return;
  }
  try {
    const info = await transporter.sendMail({
      from: '"Graficzek" <hello@graficzek.pl>',
      to,
      subject,
      html,
    });
    console.log('[mailer] Sent to', to, '— messageId:', info.messageId);
  } catch (err) {
    console.error('[mailer] Failed to send to', to, '—', err.message);
    throw err;
  }
}

module.exports = { sendMail };
