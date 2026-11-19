import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/app.css';
import './styles/shell.css';
import './styles/catalog.css';
import './styles/pages.css';
import './styles/wishlist.css';
import './styles/offers.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
