import { useState } from 'react';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

interface FirmwareUpdateDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (wpaKey: string | undefined, wpaKey24: string | undefined, skipReconfigure: boolean) => void;
}

/** Confirm a robot radio firmware update, and ask for the passphrase its reconfigure needs. */
export function FirmwareUpdateDialog({ open, onClose, onSubmit }: FirmwareUpdateDialogProps) {
  const [wpaKey, setWpaKey] = useState('');
  const [wpaKey24, setWpaKey24] = useState('');
  const [skipReconfigure, setSkipReconfigure] = useState(false);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <form
        onSubmit={e => {
          e.preventDefault();
          onSubmit(wpaKey || undefined, wpaKey24 || undefined, skipReconfigure);
          onClose();
        }}
      >
        <DialogTitle>Update Radio Firmware</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            This will flash the latest firmware to the robot radio. The radio will reboot during the process (2-3
            minutes).
          </Typography>
          {!skipReconfigure && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                The current configuration (team number, SSID suffix) will be re-applied after the update. Enter the WPA
                passphrase below, or leave blank to auto-detect from the station config.
              </Typography>
              <TextField
                label="6 GHz WPA Passphrase (optional)"
                value={wpaKey}
                onChange={e => setWpaKey(e.target.value)}
                fullWidth
                autoFocus
                helperText="Leave blank to auto-detect from station config"
                margin="dense"
              />
              <TextField
                label="2.4 GHz WPA Passphrase (optional)"
                value={wpaKey24}
                onChange={e => setWpaKey24(e.target.value)}
                fullWidth
                helperText="Leave blank to use the same key as 6 GHz"
                margin="dense"
              />
            </>
          )}
          <FormControlLabel
            control={
              <Checkbox checked={skipReconfigure} onChange={e => setSkipReconfigure(e.target.checked)} size="small" />
            }
            label={
              <Typography variant="body2" color="text.secondary">
                Flash firmware only — skip reconfiguration
              </Typography>
            }
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" color="warning">
            {skipReconfigure ? 'Flash Firmware' : 'Update & Reconfigure'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
