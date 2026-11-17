import { createRoot } from 'react-dom/client';
import { TestPage } from '../components/TestPage';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <TestPage />
  </WrapAll>,
);
