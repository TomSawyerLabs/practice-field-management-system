import { StationName } from '../../../src/types';
import StationStatus from './StationStatus';
import { SystemInfo } from './SystemInfo';

export function StationPage({ station }: { station: StationName }) {
  return (
    <>
      <StationStatus full station={station} />
      <SystemInfo />
    </>
  );
}
