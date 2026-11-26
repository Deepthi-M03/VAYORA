/* Interface strings for the rider-facing screens. Missing keys fall back to English. */
import { createContext, useContext } from 'react'

export const LANGS = { en: 'English', ta: 'தமிழ்', hi: 'हिन्दी', ml: 'മലയാളം', kn: 'ಕನ್ನಡ', te: 'తెలుగు' }
export const SPEECH_LOCALE = { en: 'en-IN', ta: 'ta-IN', hi: 'hi-IN', ml: 'ml-IN', kn: 'kn-IN', te: 'te-IN' }

const S = {
  en: {
    book: 'Book a ride', rides: 'My rides', offers: 'Offers', support: 'Support', profile: 'Profile', signout: 'Sign out',
    whereTo: 'Where to?', pickup: 'Pickup', drop: 'Drop', now: 'Now', schedule: 'Schedule', estimate: 'Estimated fare',
    confirm: 'Confirm booking', cash: 'Cash', online: 'UPI / Card', coupon: 'Coupon code', apply: 'Apply',
    cancelRide: 'Cancel ride', freeCancel: 'Free cancellation for', callDriver: 'Call driver', chat: 'Chat', sos: 'SOS',
    otp: 'Share this OTP with your driver', rate: 'Rate your trip', finalFare: 'Final fare', pay: 'Pay now',
    searching: 'Finding a driver near you', useLocation: 'Use my location', choosePickup: 'Choose a pickup point',
  },
  ta: {
    book: 'சவாரி பதிவு', rides: 'என் சவாரிகள்', offers: 'சலுகைகள்', support: 'உதவி', profile: 'சுயவிவரம்', signout: 'வெளியேறு',
    whereTo: 'எங்கே போகணும்?', pickup: 'ஏறும் இடம்', drop: 'இறங்கும் இடம்', now: 'இப்போது', schedule: 'நேரம் குறி',
    estimate: 'மதிப்பிடப்பட்ட கட்டணம்', confirm: 'பதிவை உறுதி செய்', cash: 'பணம்', online: 'UPI / கார்டு', coupon: 'கூப்பன்',
    apply: 'பயன்படுத்து', cancelRide: 'ரத்து செய்', freeCancel: 'இலவச ரத்து', callDriver: 'ஓட்டுநரை அழை', chat: 'அரட்டை',
    sos: 'அவசரம்', otp: 'இந்த OTP-ஐ ஓட்டுநரிடம் சொல்லுங்கள்', rate: 'மதிப்பிடுங்கள்', finalFare: 'இறுதி கட்டணம்', pay: 'செலுத்து',
    searching: 'அருகிலுள்ள ஓட்டுநரைத் தேடுகிறோம்', useLocation: 'என் இருப்பிடம்', choosePickup: 'ஏறும் இடத்தைத் தேர்வு செய்க',
  },
  hi: {
    book: 'राइड बुक करें', rides: 'मेरी राइड्स', offers: 'ऑफ़र', support: 'सहायता', profile: 'प्रोफ़ाइल', signout: 'साइन आउट',
    whereTo: 'कहाँ जाना है?', pickup: 'पिकअप', drop: 'ड्रॉप', now: 'अभी', schedule: 'शेड्यूल', estimate: 'अनुमानित किराया',
    confirm: 'बुकिंग पक्की करें', cash: 'नकद', online: 'UPI / कार्ड', coupon: 'कूपन कोड', apply: 'लागू करें',
    cancelRide: 'राइड रद्द करें', freeCancel: 'मुफ़्त रद्दीकरण', callDriver: 'ड्राइवर को कॉल', chat: 'चैट', sos: 'SOS',
    otp: 'यह OTP ड्राइवर को बताएं', rate: 'राइड को रेट करें', finalFare: 'अंतिम किराया', pay: 'भुगतान करें',
    searching: 'पास में ड्राइवर ढूँढ रहे हैं', useLocation: 'मेरी लोकेशन', choosePickup: 'पिकअप चुनें',
  },
  ml: { book: 'യാത്ര ബുക്ക് ചെയ്യുക', whereTo: 'എവിടേക്ക്?', confirm: 'ബുക്കിംഗ് ഉറപ്പാക്കുക', estimate: 'കണക്കാക്കിയ നിരക്ക്', rides: 'എന്റെ യാത്രകൾ' },
  kn: { book: 'ಸವಾರಿ ಬುಕ್ ಮಾಡಿ', whereTo: 'ಎಲ್ಲಿಗೆ?', confirm: 'ಬುಕಿಂಗ್ ಖಚಿತಪಡಿಸಿ', estimate: 'ಅಂದಾಜು ದರ', rides: 'ನನ್ನ ಸವಾರಿಗಳು' },
  te: { book: 'రైడ్ బుక్ చేయండి', whereTo: 'ఎక్కడికి?', confirm: 'బుకింగ్ నిర్ధారించండి', estimate: 'అంచనా ఛార్జీ', rides: 'నా రైడ్‌లు' },
}

export const LangCtx = createContext({ lang: 'en', setLang: () => {} })
export function useT() {
  const { lang } = useContext(LangCtx)
  return (k) => S[lang]?.[k] ?? S.en[k] ?? k
}
