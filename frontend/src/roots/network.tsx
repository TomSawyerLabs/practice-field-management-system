import { createRoot } from 'react-dom/client';
import { NetworkPage } from '../components/NetworkPage';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <NetworkPage />
  </WrapAll>,
);
