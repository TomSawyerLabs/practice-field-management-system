import { createRoot } from 'react-dom/client';
import { MatchControlPage } from '../components/MatchControlPage';
import { MatchAudioBridge } from '../hooks/useMatchAudio';
import { WrapAll } from './wrap';

createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <MatchAudioBridge />
    <MatchControlPage />
  </WrapAll>,
);
