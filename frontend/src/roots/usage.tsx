import { createRoot } from 'react-dom/client';
import { UsagePage } from '../components/UsagePage';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <UsagePage />
  </WrapAll>,
);
