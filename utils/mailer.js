const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'serwer2589336.home.pl',
  port: 587,
  secure: false, // STARTTLS on 587
  auth: {
    user: 'hello@graficzek.pl',
    pass: process.env.MAIL_PASSWORD,
  },
  tls: { rejectUnauthorized: false },
});

async function sendMail({ to, subject, html }) {
  return transporter.sendMail({
    from: '"Graficzek" <hello@graficzek.pl>',
    to,
    subject,
    html,
  });
}

module.exports = { sendMail };
