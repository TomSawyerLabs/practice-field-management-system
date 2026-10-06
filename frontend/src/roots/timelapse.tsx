import { createRoot } from 'react-dom/client';
import { TimelapsePage } from '../components/timelapse/TimelapsePage';
import { WrapAll } from './wrap';

// Open to anyone, like /recordings: watching changes nothing. The settings
// are in Admin → Video.
createRoot(document.getElementById('root')!).render(
  <WrapAll showReconfigOverlay={false}>
    <TimelapsePage />
  </WrapAll>,
);
