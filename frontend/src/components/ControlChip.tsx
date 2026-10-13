import Typography from '@mui/material/Typography';

/** Small labeled control button for the scoreboard's top-right corner. */
export function ControlChip({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <Typography
      onClick={onClick}
      sx={{
        cursor: 'pointer',
        fontSize: '0.75rem',
        lineHeight: 1,
        px: 1,
        py: 0.5,
        borderRadius: 1,
        border: `1px solid ${active ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.25)'}`,
        color: active ? '#fff' : 'rgba(255,255,255,0.75)',
        backgroundColor: active ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.4)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        '&:hover': { backgroundColor: 'rgba(255,255,255,0.25)', color: '#fff' },
      }}
    >
      {icon} {label}
    </Typography>
  );
}
