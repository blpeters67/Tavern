import '@fontsource-variable/inter/index.css';
import '@fontsource/cinzel/500.css';
import '@fontsource/cinzel/600.css';
import '@fontsource/cinzel/700.css';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/eb-garamond/500.css';
import '@fontsource/eb-garamond/600.css';
import '@fontsource/eb-garamond/600-italic.css';
import '@fontsource/eb-garamond/700.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/noto-sans-runic/400.css';
import './styles/base.css';
import './styles/auth.css';
import './styles/layout.css';
import './styles/chat.css';
import './styles/input.css';
import './styles/overlays.css';
import './styles/settings.css';
import './styles/theme.css';
import './styles/roleplay.css';
import './styles/effects.css';
import './styles/voice.css';
import './styles/jukebox.css';
import './styles/theater.css';
import './styles/sheet.css';
import './styles/dice.css';
import './styles/community.css';
import './styles/mobile.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './lib/shiftKey';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
