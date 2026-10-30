import Grid from '@mui/material/Grid';
import { StationName } from '../../../src/types';
import StationStatus from './StationStatus';

/** Render a group of station slots (first half or second half). */
export function SlotGroup({ slots }: { slots: readonly StationName[] }) {
  return (
    <Grid size={{ xs: 12, md: 6 }}>
      {slots.map(station => (
        <StationStatus key={station} station={station} />
      ))}
    </Grid>
  );
}
