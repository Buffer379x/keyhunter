import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/app.css';
import './styles/catalog.css';
import './styles/dashboard.css';
import './styles/release040.css';
import './styles/release041.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
