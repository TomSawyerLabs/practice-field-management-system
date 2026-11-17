import { createRoot } from 'react-dom/client';
import { MainPage } from '../components/MainPage';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <MainPage />
  </WrapAll>,
);
