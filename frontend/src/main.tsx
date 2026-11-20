import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/app.css';
import './styles/ui.css';
import './styles/catalog.css';
import './styles/pages.css';
import './styles/detail.css';
import './styles/alerts.css';
import './styles/wishlist.css';
import './styles/offers.css';
import './styles/shell.css';

const root = createRoot(document.getElementById('root')!);
if (import.meta.env.DEV && window.location.pathname === '/_ui') {
  void import('./ui/Gallery').then(({ default: Gallery }) => root.render(<StrictMode><Gallery /></StrictMode>));
} else {
  root.render(<StrictMode><App /></StrictMode>);
}
