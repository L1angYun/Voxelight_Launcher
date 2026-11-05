import React from 'react';
import ReactDOM from 'react-dom/client';
import './design/fonts.css';
import './design/tokens.css';
import './design/global.css';
import './design/surfaces.css';
import { App } from './app/App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
