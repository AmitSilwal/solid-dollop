# Real-time Chat App

A simple real-time chat app built with **Node.js**, **Express**, **Socket.IO**, and a lightweight **React** frontend.

## Features

- User registration and login (JWT-based)
- JWT middleware for protected API routes
- JWT-gated Socket.IO authentication
- Online presence indicators
- Direct messaging between users in real time
- Conversation history retrieval via API
- End-to-end encryption (hybrid AES-GCM + RSA-OAEP)

## End-to-end encryption details

- Each user generates an RSA public/private keypair in the browser after login/registration.
- The private key stays in browser `localStorage` and is never sent to the server.
- The client uploads only the user's public key to the backend.
- Each message is encrypted on the sender's device using a one-time AES-GCM key.
- The AES key is wrapped twice with RSA-OAEP:
  - once with the recipient's public key (for recipient decryption)
  - once with the sender's public key (so senders can decrypt their own sent history)
- The server stores and forwards only encrypted payloads and wrapped keys, and cannot decrypt message contents.

## Run locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the app:

   ```bash
   npm start
   ```

3. Open:

   ```text
   http://localhost:3000
   ```

## Notes

- This project uses in-memory storage for users/messages, so data resets on server restart.
- Set a secure secret in production:

  ```bash
  JWT_SECRET=your-secret npm start
  ```
