import logo from '@/assets/sixth-history/logo.png';

/**
 * The Sixth History Community Licence's attribution.
 *
 * This is a licence obligation, not decoration. The occult theme dresses the
 * app in Weather Factory's Secret Histories idiom, which their community
 * licence permits on two conditions that both have to be VISIBLE: the work
 * must say it is unofficial, and it must display the Sixth History logo. The
 * theme is the only one the app has, so the credit always renders.
 *
 * The wording is the licence's own suggested sentence, filled in for this
 * product. See assets/sixth-history/ATTRIBUTION-SIXTH-HISTORY.md for the full
 * obligation list and where each one is met.
 */
export function SixthHistoryCredit() {
  return (
    <div
      style={{
        marginRight: 'auto',
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 'var(--cth-text-body-sm)',
        lineHeight: 'var(--cth-lh-body-sm)',
        color: 'var(--cth-ink-500)'
      }}
    >
      <img
        src={logo}
        alt="Sixth History"
        style={{
          height: 20, width: 20, flexShrink: 0,
          // The mark ships black on transparent and this theme's grounds are
          // near-black. The licence permits recolouring, so it is inverted to
          // parchment here rather than being redrawn — an altered logo is the
          // one thing the licence does not allow.
          filter: 'invert(1)'
        }}
      />
      <span>
        The occult theme is unofficial content based on the Secret Histories by
        Weather Factory Ltd. You can find out more and support the Secret
        Histories at www.weatherfactory.biz.
      </span>
    </div>
  );
}
