import { useState, useEffect, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import LockIcon from '@mui/icons-material/Lock';

import {
  ADMIN_TOKEN_KEY,
  useAdminAuth,
  useWsConnected,
  sendAdminLogin,
  sendAdminCheckAuth,
  sendAdminSetPassphrase,
} from '../hooks/useBackend';

/**
 * Wraps the admin page content. If admin auth is configured,
 * requires passphrase login before showing children.
 * If no passphrase is set, prompts the user to create one.
 */
export function AdminAuthGate({ children }: { children: ReactNode }) {
  const authResult = useAdminAuth();
  const wsConnected = useWsConnected();
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);

  // On every (re)connect: a stored token is re-presented by the socket layer
  // itself (useBackend's onopen), since admin rights belong to the socket.
  // Without one, ask whether a passphrase is configured at all.
  useEffect(() => {
    if (!wsConnected) return;
    if (!localStorage.getItem(ADMIN_TOKEN_KEY)) sendAdminCheckAuth('');
  }, [wsConnected]);

  // Handle auth result changes
  useEffect(() => {
    if (!authResult) return;
    setChecking(false);

    if (authResult.authenticated && authResult.token) {
      // Save token for future sessions
      localStorage.setItem(ADMIN_TOKEN_KEY, authResult.token);
    }

    if (!authResult.authenticated && authResult.passphraseConfigured) {
      // Clear invalid token
      const token = localStorage.getItem(ADMIN_TOKEN_KEY);
      if (token) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
      }
    }
  }, [authResult]);

  // Still checking auth on mount
  if (checking && !authResult) {
    return (
      <Container maxWidth="sm" sx={{ py: 8, textAlign: 'center' }}>
        <Typography variant="body1" color="text.secondary">
          Checking authentication...
        </Typography>
      </Container>
    );
  }

  // Authenticated — show admin content
  if (authResult?.authenticated) {
    return <>{children}</>;
  }

  // Not authenticated but passphrase is configured — show login
  if (authResult?.passphraseConfigured) {
    const handleLogin = () => {
      if (!passphrase) return;
      setError('');
      sendAdminLogin(passphrase);
      // Clear passphrase field (result comes via authResult)
      setTimeout(() => {
        if (!authResult?.authenticated) {
          setError('Invalid passphrase');
        }
      }, 1000);
    };

    return (
      <Container maxWidth="sm" sx={{ py: 8 }}>
        <Card>
          <CardContent sx={{ textAlign: 'center', py: 4 }}>
            <LockIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h5" gutterBottom>
              Admin Login
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Enter the admin passphrase to access the field admin panel.
            </Typography>

            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}

            <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-end' }}>
              <TextField
                fullWidth
                type="password"
                label="Passphrase"
                value={passphrase}
                onChange={e => {
                  setPassphrase(e.target.value);
                  setError('');
                }}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                autoFocus
              />
              <Button variant="contained" onClick={handleLogin} disabled={!passphrase}>
                Login
              </Button>
            </Box>
          </CardContent>
        </Card>
      </Container>
    );
  }

  // No passphrase configured — first-time setup
  const handleSetPassphrase = () => {
    if (!passphrase || passphrase.length < 4) {
      setError('Passphrase must be at least 4 characters');
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError('Passphrases do not match');
      return;
    }
    setError('');
    sendAdminSetPassphrase(passphrase);
  };

  return (
    <Container maxWidth="sm" sx={{ py: 8 }}>
      <Card>
        <CardContent sx={{ textAlign: 'center', py: 4 }}>
          <LockIcon sx={{ fontSize: 48, color: 'warning.main', mb: 2 }} />
          <Typography variant="h5" gutterBottom>
            Set Admin Passphrase
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            No admin passphrase has been configured yet. Set one now to secure the admin panel.
          </Typography>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField
              fullWidth
              type="password"
              label="New Passphrase"
              value={passphrase}
              onChange={e => {
                setPassphrase(e.target.value);
                setError('');
              }}
              helperText="At least 4 characters"
              autoFocus
            />
            <TextField
              fullWidth
              type="password"
              label="Confirm Passphrase"
              value={confirmPassphrase}
              onChange={e => {
                setConfirmPassphrase(e.target.value);
                setError('');
              }}
              onKeyDown={e => e.key === 'Enter' && handleSetPassphrase()}
            />
            <Button variant="contained" onClick={handleSetPassphrase} disabled={!passphrase || passphrase.length < 4}>
              Set Passphrase & Continue
            </Button>
          </Box>
        </CardContent>
      </Card>
    </Container>
  );
}
