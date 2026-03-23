# Real-time Chat App

A simple real-time chat app built with **Node.js**, **Express**, **Socket.IO**, and a lightweight **React** frontend.

## Features

- User registration and login (JWT-based)
- Online presence indicators
- Direct messaging between users in real time
- Conversation history retrieval via API

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
