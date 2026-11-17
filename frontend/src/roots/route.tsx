import { createRoot } from 'react-dom/client';
import { RoutePage } from '../components/RoutePage';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <RoutePage />
  </WrapAll>,
);
