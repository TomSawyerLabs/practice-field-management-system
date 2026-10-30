import { createRoot } from 'react-dom/client';
import { SlotGroup } from '../components/SlotGroup';
import { DsClientNotice } from '../components/DsClientGuard';
import { WrapAll } from './wrap';
import Grid from '@mui/material/Grid';
import Container from '@mui/material/Container';
import { StationNameList } from '../../../src/types';

createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <Container maxWidth="xl" sx={{ py: 2 }}>
      <DsClientNotice />
      <Grid container spacing={2}>
        <SlotGroup slots={StationNameList.slice(0, 3)} />
        <SlotGroup slots={StationNameList.slice(3)} />
      </Grid>
    </Container>
  </WrapAll>,
);
