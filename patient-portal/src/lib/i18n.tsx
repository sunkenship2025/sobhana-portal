import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'te';

/**
 * Bilingual UI strings. English is authoritative; the Telugu is a first-pass DRAFT —
 * have a native speaker review before launch (medical/consent phrasing especially).
 * Test names, patient names and numbers stay English by design.
 * `{name}` placeholders are filled by t(key, { name }).
 */
const STRINGS = {
  // Login
  promiseEn: { en: 'View your reports & bills', te: 'View your reports & bills' },
  promiseTe: { en: 'మీ రిపోర్ట్‌లు, బిల్లులు చూడండి', te: 'మీ రిపోర్ట్‌లు, బిల్లులు చూడండి' },
  mobileNumber: { en: 'Mobile number', te: 'మొబైల్ నంబర్' },
  enterNumber: { en: 'Enter number', te: 'నంబర్ నమోదు చేయండి' },
  sendCode: { en: 'Send code', te: 'కోడ్ పంపండి' },
  whatsappHint: { en: "We'll send a 6-digit code to this number on WhatsApp.", te: 'ఈ నంబర్‌కు వాట్సాప్‌లో 6-అంకెల కోడ్ పంపుతాము.' },
  trouble: { en: 'Trouble?', te: 'సమస్యా?' },
  callUs: { en: 'Call us', te: 'మాకు కాల్ చేయండి' },
  enterCode: { en: 'Enter code', te: 'కోడ్ నమోదు చేయండి' },
  codeSentTo: { en: 'Code sent on WhatsApp to', te: 'వాట్సాప్‌లో కోడ్ పంపబడింది' },
  change: { en: 'Change', te: 'మార్చు' },
  verify: { en: 'Verify', te: 'ధృవీకరించు' },
  resendIn: { en: 'Resend code in {t}', te: '{t}లో మళ్లీ పంపండి' },
  resendCode: { en: 'Resend code', te: 'మళ్లీ కోడ్ పంపండి' },
  didntGet: { en: "Didn't get it?", te: 'కోడ్ రాలేదా?' },
  noCodeHint: {
    en: "No code yet? Make sure it's the number you registered with at the centre.",
    te: 'కోడ్ రాలేదా? కేంద్రంలో మీరు నమోదు చేసిన నంబర్ ఇదేనా చూసుకోండి.',
  },
  incorrectCode: { en: 'Incorrect code.', te: 'తప్పు కోడ్.' },
  tooMany: { en: 'Too many attempts. Please wait a few minutes and try again.', te: 'చాలా ప్రయత్నాలు. కొన్ని నిమిషాలు ఆగి మళ్లీ ప్రయత్నించండి.' },
  sendFailed: { en: "Couldn't send the code. Please check your connection and try again.", te: 'కోడ్ పంపడం విఫలమైంది. మీ కనెక్షన్ చూసి మళ్లీ ప్రయత్నించండి.' },
  // Home chrome
  signedIn: { en: 'Signed in', te: 'సైన్ ఇన్ అయ్యారు' },
  logOut: { en: 'Log out', te: 'సైన్ అవుట్' },
  familyLinked: { en: 'This number is linked to {n} people', te: 'ఈ నంబర్‌కు {n} మంది అనుసంధానించబడ్డారు' },
  familySub: { en: "Everyone's reports & bills show here — tap a name to see just one person.", te: 'అందరి రిపోర్ట్‌లు, బిల్లులు ఇక్కడ కనిపిస్తాయి — ఒక్కరిని చూడటానికి పేరుపై నొక్కండి.' },
  gotIt: { en: 'Got it', te: 'అర్థమైంది' },
  all: { en: 'All', te: 'అందరూ' },
  search: { en: 'Search', te: 'వెతకండి' },
  searchPlaceholder: { en: 'Search tests, dates, bill no.', te: 'పరీక్షలు, తేదీలు, బిల్లు నం. వెతకండి' },
  filterByDate: { en: 'Filter by date', te: 'తేదీ ప్రకారం వడపోయండి' },
  anyDate: { en: 'Any date', te: 'ఏ తేదీ అయినా' },
  // Buckets
  reports: { en: 'Reports', te: 'రిపోర్ట్‌లు' },
  awaitingPayment: { en: 'Awaiting payment', te: 'చెల్లింపు కోసం వేచి ఉంది' },
  onTheWay: { en: 'On the way', te: 'రాబోతున్నాయి' },
  resultsExpected: { en: 'Results expected', te: 'ఫలితాలు రావలసి ఉంది' },
  view: { en: 'View', te: 'చూడండి' },
  bill: { en: 'Bill', te: 'బిల్లు' },
  viewBill: { en: 'View bill', te: 'బిల్లు చూడండి' },
  downloadReport: { en: 'Download report', te: 'రిపోర్ట్ డౌన్‌లోడ్ చేయండి' },
  downloadBill: { en: 'Download bill', te: 'బిల్లు డౌన్‌లోడ్ చేయండి' },
  dueLabel: { en: '{amt} due', te: '{amt} బాకీ' },
  dueMsg: { en: '{amt} due — your report unlocks once the bill is cleared', te: '{amt} బాకీ — బిల్లు చెల్లించిన తర్వాత మీ రిపోర్ట్ అందుబాటులోకి వస్తుంది' },
  newBadge: { en: 'New', te: 'కొత్తది' },
  noMatch: { en: 'No visits match.', te: 'సరిపోలే విజిట్‌లు లేవు.' },
  clearFilters: { en: 'Clear filters', te: 'ఫిల్టర్‌లు తొలగించండి' },
  helpContact: { en: 'Help & contact —', te: 'సహాయం & సంప్రదింపు —' },
  reachUs: { en: 'reach us', te: 'మమ్మల్ని సంప్రదించండి' },
  // States
  noReportsYet: { en: 'No reports yet', te: 'ఇంకా రిపోర్ట్‌లు లేవు' },
  nothingYet: { en: 'Nothing here yet', te: 'ఇంకా ఏమీ లేదు' },
  nothingYetSub: { en: "Your reports will appear here as soon as they're signed. We'll message you on WhatsApp the moment they're ready.", te: 'మీ రిపోర్ట్‌లు సిద్ధమైన వెంటనే ఇక్కడ కనిపిస్తాయి. సిద్ధమైన వెంటనే వాట్సాప్‌లో తెలియజేస్తాము.' },
  noRecords: { en: 'No records for this number', te: 'ఈ నంబర్‌కు రికార్డులు లేవు' },
  noRecordsSub: { en: "We couldn't find any records for {phone}. If you tested under a different number, sign in with that one — or call us and we'll link it.", te: '{phone} కోసం రికార్డులు కనబడలేదు. మీరు వేరే నంబర్‌తో పరీక్ష చేయించుకుంటే, ఆ నంబర్‌తో సైన్ ఇన్ చేయండి — లేదా మాకు కాల్ చేయండి, అనుసంధానిస్తాము.' },
  somethingWrong: { en: 'Something went wrong', te: 'ఏదో పొరపాటు జరిగింది' },
  somethingWrongSub: { en: "We couldn't load your reports just now. Please try again in a moment.", te: 'ప్రస్తుతం మీ రిపోర్ట్‌లు లోడ్ చేయలేకపోయాము. కొద్దిసేపటి తర్వాత మళ్లీ ప్రయత్నించండి.' },
  tryAgain: { en: 'Try again', te: 'మళ్లీ ప్రయత్నించండి' },
  // Help
  help: { en: 'Help', te: 'సహాయం' },
  callACentre: { en: 'Call a centre', te: 'ఒక కేంద్రానికి కాల్ చేయండి' },
  commonQuestions: { en: 'Common questions', te: 'సాధారణ ప్రశ్నలు' },
  q1: { en: 'Reports not showing? Sign in with the number you registered at the centre.', te: 'రిపోర్ట్‌లు కనిపించడం లేదా? కేంద్రంలో నమోదు చేసిన నంబర్‌తో సైన్ ఇన్ చేయండి.' },
  q2: { en: 'A balance due? Clear it at the centre and the report unlocks.', te: 'బాకీ ఉందా? కేంద్రంలో చెల్లిస్తే రిపోర్ట్ అందుబాటులోకి వస్తుంది.' },
  q3: { en: "Wrong number linked to you? Call the centre and we'll fix it.", te: 'తప్పు నంబర్ అనుసంధానమైందా? కేంద్రానికి కాల్ చేయండి, సరిచేస్తాము.' },
  q4: { en: 'Need an older report? Search by test name or date on the home screen.', te: 'పాత రిపోర్ట్ కావాలా? హోమ్ స్క్రీన్‌లో పరీక్ష పేరు లేదా తేదీతో వెతకండి.' },
  // Doc view
  report: { en: 'Report', te: 'రిపోర్ట్' },
  billDoc: { en: 'Bill', te: 'బిల్లు' },
  download: { en: 'Download', te: 'డౌన్‌లోడ్' },
  share: { en: 'Share', te: 'పంచుకోండి' },
  openNewTab: { en: 'Open in new tab', te: 'కొత్త ట్యాబ్‌లో తెరవండి' },
  cantSee: { en: "Can't see it?", te: 'కనిపించడం లేదా?' },
  wasUpdated: { en: 'This {doc} was updated', te: 'ఈ {doc} నవీకరించబడింది' },
  wasUpdatedSub: { en: 'A newer, corrected version has replaced it. Open your reports to view the current one.', te: 'కొత్త, సరిదిద్దిన వెర్షన్ దీన్ని భర్తీ చేసింది. ప్రస్తుత దాన్ని చూడటానికి మీ రిపోర్ట్‌లు తెరవండి.' },
  openReports: { en: 'Open reports', te: 'రిపోర్ట్‌లు తెరవండి' },
  notFound: { en: '{doc} not found', te: '{doc} కనబడలేదు' },
  atCentre: { en: "This {doc} isn't available online", te: 'ఈ {doc} ఆన్‌లైన్‌లో అందుబాటులో లేదు' },
  atCentreSub: {
    en: "Please visit your nearest Sobhana Diagnostics centre to collect it, or call us and we'll help you.",
    te: 'దయచేసి మీ దగ్గరి శోభన డయాగ్నోస్టిక్స్ కేంద్రానికి వచ్చి తీసుకోండి, లేదా మాకు కాల్ చేయండి, మేము సహాయం చేస్తాము.',
  },
  notFoundSub: { en: "This {doc} may have been moved. Go back and open it again, or call us and we'll help.", te: 'ఈ {doc} తరలించబడి ఉండవచ్చు. వెనక్కి వెళ్లి మళ్లీ తెరవండి, లేదా మాకు కాల్ చేయండి.' },
  backToReports: { en: 'Back to reports', te: 'రిపోర్ట్‌లకు తిరిగి' },
  cantOpen: { en: "Couldn't open the {doc}", te: '{doc} తెరవలేకపోయాము' },
  cantOpenSub: { en: 'Please try again in a moment, or open it in a new tab.', te: 'కొద్దిసేపటి తర్వాత మళ్లీ ప్రయత్నించండి, లేదా కొత్త ట్యాబ్‌లో తెరవండి.' },
  // Smart Report. Telugu here is DRAFT like the rest of this file — the product
  // name is transliterated rather than translated, which is how patients say it.
  smartReport: { en: 'Smart Report', te: 'స్మార్ట్ రిపోర్ట్' },
  smartReportHint: {
    en: 'What your results mean, in simple words',
    te: 'మీ ఫలితాల అర్థం, సులభమైన మాటల్లో',
  },
  smartLoading: { en: 'Opening your Smart Report…', te: 'మీ స్మార్ట్ రిపోర్ట్ తెరుస్తున్నాము…' },
};

type Key = keyof typeof STRINGS;

const LangCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'en', setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => (localStorage.getItem('lang') === 'te' ? 'te' : 'en'));
  const setLang = useCallback((l: Lang) => {
    localStorage.setItem('lang', l);
    setLangState(l);
  }, []);
  return <LangCtx.Provider value={{ lang, setLang }}>{children}</LangCtx.Provider>;
}

export function useLang() {
  return useContext(LangCtx);
}

export function useT() {
  const { lang } = useLang();
  return (key: Key, params?: Record<string, string | number>) => {
    const s = STRINGS[key]?.[lang] ?? STRINGS[key]?.en ?? key;
    return params ? s.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? '')) : s;
  };
}

/** The EN | తె toggle. The active language is bold. */
export function LangToggle({ dark }: { dark?: boolean }) {
  const { lang, setLang } = useLang();
  return (
    <button
      className={'lang' + (dark ? ' langdark' : '')}
      onClick={() => setLang(lang === 'en' ? 'te' : 'en')}
      aria-label="Language"
    >
      {lang === 'en' ? (
        <><b>EN</b> | <span className="te">తె</span></>
      ) : (
        <><span>EN</span> | <b className="te">తె</b></>
      )}
    </button>
  );
}
