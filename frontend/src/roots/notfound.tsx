import { createRoot } from 'react-dom/client';
import { NotFoundPage } from '../components/NotFoundPage';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <NotFoundPage />
  </WrapAll>,
);
