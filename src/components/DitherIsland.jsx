import Dither from './Dither.jsx';

export default function DitherIsland() {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Dither
        waveColor={[0.6, 0.6, 0.55]}
        disableAnimation={false}
        enableMouseInteraction={true}
        mouseRadius={0.3}
        colorNum={4}
        waveAmplitude={0.3}
        waveFrequency={3}
        waveSpeed={0.05}
      />
    </div>
  );
}
