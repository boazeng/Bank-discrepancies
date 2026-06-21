import './TactLogo.css'

/* The TACT brand mark: spaced T·A·C·T letters with rust dots between,
   plus a word ("accounting" by default) on the other side of the mark.

   Props:
     tone:        "light" (ink letters, for light surfaces) | "dark" (cream
                  letters on the ink chip)
     size:        scales the whole lockup (number, default 1)
     word:        string shown after T·A·C·T. Default "accounting".
                  Pass any string to override (e.g. word="urban energy").
                  Pass false or "" to hide entirely.
     tagline:     show a tagline line under the mark (boolean)
     taglineText: the tagline content (string) */
export default function TactLogo({
  tone = 'light',
  size = 1,
  word = 'accounting',
  tagline = false,
  taglineText = ''
}) {
  const letters = ['T', 'A', 'C', 'T']
  return (
    <span className={`tact-logo tact-logo-${tone}`} style={{ '--tact-scale': size }}>
      <span className="tact-logo-lockup">
        <span className="tact-logo-row">
          <span className="tact-logo-mark">
            {letters.map((l, i) => (
              <span key={i} className="tact-logo-seg">
                <span className="tact-logo-letter">{l}</span>
                {i < letters.length - 1 && <span className="tact-logo-dot" />}
              </span>
            ))}
          </span>
          {word && <span className="tact-logo-word">{word}</span>}
        </span>
        {tagline && <span className="tact-logo-tagline">{taglineText}</span>}
      </span>
    </span>
  )
}
