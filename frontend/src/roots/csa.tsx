import { createRoot } from 'react-dom/client';
import { CsaPage } from '../components/CsaPage';
import { WrapAll } from './wrap';

// The reconfiguration backdrop is left off: a CSA wants to watch the field
// *through* a radio reconfigure, not be blocked by it.
createRoot(document.getElementById('root')!).render(
  <WrapAll showReconfigOverlay={false}>
    <CsaPage />
  </WrapAll>,
);
