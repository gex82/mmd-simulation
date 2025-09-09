import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Entrypoint: render the App component into the root element.
const container = document.getElementById('root');
createRoot(container).render(<App />);