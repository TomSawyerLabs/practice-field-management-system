import { createRoot } from 'react-dom/client';
import { TeamLoginPage } from '../components/TeamLoginPage';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <TeamLoginPage />
  </WrapAll>,
);
