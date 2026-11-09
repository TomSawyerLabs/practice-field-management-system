import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import {
  sendGameDelete,
  sendGameReload,
  sendGameUpload,
  sendUpdateSetupSettings,
  useGameActionResult,
  useGameCatalog,
} from '../hooks/useBackend';
import { gamePeriods, hasAutoWinner, type GameCatalogEntry, type GameDefinition } from '../utils/game';

const SOURCE_LABEL: Record<GameCatalogEntry['source'], string> = {
  builtin: 'Built-in',
  file: 'Custom',
  plugin: 'Plugin',
};

/** "20 s auto · 140 s teleop · 4 goal shifts · game data" */
function summary(game: GameDefinition): string {
  const t = game.timing;
  const parts: string[] = [];
  if (t.autoDuration > 0) parts.push(`${t.autoDuration} s auto`);
  parts.push(`${t.teleopDuration} s teleop`);
  if (t.endgameDuration > 0) parts.push(`${t.endgameDuration} s endgame`);
  const switching = gamePeriods(game).filter(p => p.goalOff).length;
  if (switching > 0) parts.push(`${switching} goal ${switching === 1 ? 'switch' : 'switches'}`);
  if (hasAutoWinner(game)) parts.push('auto winner');
  if (game.gameData) parts.push('game data');
  if (game.elements?.length) parts.push(`${game.elements.length} scoring elements`);
  if (game.ruleHooks?.length) parts.push(`code: ${game.ruleHooks.join(', ')}`);
  return parts.join(' · ');
}

/**
 * /admin: which game the field runs. Lists the built-in games and every
 * file in the games directory (with why a broken one didn't load), switches
 * the game for the next match, and uploads or deletes JSON games. Plugins
 * are listed but only ever come from disk.
 */
export function GameSection() {
  const catalog = useGameCatalog();
  const result = useGameActionResult();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    setBusy(false);
  }, [result]);

  if (!catalog) return null;

  const ok = catalog.games.filter(g => !g.errors && g.definition);
  const broken = catalog.games.filter(g => g.errors);
  const missing = catalog.selected && catalog.selected !== catalog.current;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    sendGameUpload(await file.text());
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Typography variant="h6">Game</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5, mb: 1.5 }}>
          What a regulation match runs: its timing, periods, which goal is on, and the game data the robots get. A
          switch applies to the next match, and to one that is set up but not started. A match already running keeps its
          game.
        </Typography>

        {missing && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            The selected game, <code>{catalog.selected}</code>, isn&apos;t loaded, so matches run{' '}
            {ok.find(g => g.id === catalog.current)?.name ?? catalog.current}. Fix or restore its file, then reload.
          </Alert>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {ok.map(g => {
            const def = g.definition!;
            const running = g.id === catalog.current;
            return (
              <Box
                key={g.id}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  flexWrap: 'wrap',
                  p: 1.25,
                  border: 1,
                  borderRadius: 1,
                  borderColor: running ? 'success.main' : 'divider',
                }}
              >
                <Box sx={{ flex: 1, minWidth: 220 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography sx={{ fontWeight: 600 }}>
                      {def.name}
                      {def.season ? ` (${def.season})` : ''}
                    </Typography>
                    <Chip size="small" variant="outlined" label={SOURCE_LABEL[g.source]} />
                    {g.id === catalog.elementsFrom && (
                      <Chip size="small" variant="outlined" color="info" label="Scoring elements in use" />
                    )}
                  </Box>
                  {def.description && (
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      {def.description}
                    </Typography>
                  )}
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {summary(def)}
                    {g.file ? ` · ${g.file}` : ''}
                  </Typography>
                </Box>
                {g.source === 'file' &&
                  !running &&
                  (confirmDelete === g.file ? (
                    <Button
                      size="small"
                      color="error"
                      variant="contained"
                      onClick={() => {
                        setConfirmDelete(null);
                        setBusy(true);
                        sendGameDelete(g.file!);
                      }}
                    >
                      Delete {g.file}?
                    </Button>
                  ) : (
                    <Button size="small" color="error" onClick={() => setConfirmDelete(g.file!)}>
                      Delete
                    </Button>
                  ))}
                {running ? (
                  <Chip color="success" label="Running" />
                ) : (
                  <Button variant="outlined" onClick={() => sendUpdateSetupSettings({ game: g.id })}>
                    Use this game
                  </Button>
                )}
              </Box>
            );
          })}
        </Box>

        {broken.length > 0 && (
          <Box sx={{ mt: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {broken.map(g => (
              <Alert key={g.file} severity="error">
                <strong>{g.file}</strong>
                {g.name ? ` (${g.name})` : ''} didn&apos;t load:
                <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                  {g.errors!.map(e => (
                    <li key={e}>{e}</li>
                  ))}
                </Box>
              </Alert>
            ))}
          </Box>
        )}

        <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant="outlined" component="label" disabled={busy}>
            Upload a game (.json)
            <input
              ref={fileInput}
              hidden
              type="file"
              accept=".json,application/json"
              onChange={e => void upload(e.target.files?.[0])}
            />
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              sendGameReload();
            }}
          >
            Reload games
          </Button>
        </Box>
        {result && !result.ok && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {result.action === 'upload'
              ? 'Upload refused:'
              : result.action === 'delete'
                ? 'Delete failed:'
                : 'Reload failed:'}
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              {(result.errors ?? []).map(e => (
                <li key={e}>{e}</li>
              ))}
            </Box>
          </Alert>
        )}
        {result?.ok && result.action === 'upload' && (
          <Alert severity="success" sx={{ mt: 1.5 }}>
            Saved. Choose &ldquo;Use this game&rdquo; to run it.
          </Alert>
        )}
        <Typography variant="caption" component="p" sx={{ color: 'text.secondary', mt: 1.5 }}>
          Custom games and plugins live in <code>{catalog.dir}</code> on the pFMS host. JSON games can be uploaded here;
          plugins (<code>.js</code> / <code>.ts</code>) run as code on the field, so they can only be put there by
          someone with access to the host. Edited a file there? Reload games.
        </Typography>
      </CardContent>
    </Card>
  );
}
