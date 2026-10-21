const base=new URL('./assets/comparison/',import.meta.url);
const browserNative='https://browsernative.com/wp-content/uploads/delete-browsing-data-chrome.png';
const better='https://betterhistory.io/_next/image/?url=https%3A%2F%2Fadmin.betterhistory.io%2Fuploads%2F004_76ed8dc416.jpg&w=3840&q=75';
const clear='https://lh3.googleusercontent.com/IThO1hBYbeHAhkgozZxZC9cGukQdQB47PIfSIS0D0ChyUx9N_9V0NRoet3atw0jZq7ib6kKEYgQb4G0ec8XUb5gR';
const oneclick='https://lh3.googleusercontent.com/BWtYQWQGS_e6jGF2lGocZVc5i_5IhPWjpFSfhk3AnkdashJ6GzU9I0D8Aqb2XQIxxYEGLoZr5J9eyWjxno0NEb1H=s1280-w1280-h800';
const hotcleaner='https://cdn.hotcleaner.com/img/click-and-clean-main-menu.png';
export function featureImages(product, language) {
  const lang=language===1?'zh':'en';
  const diagram = name => ({src:new URL(`${name}-${lang}.svg`,base).href,kind:language===1?'流程示意 · 点击放大':'Workflow diagram · enlarge',photo:false});
  const official=src=>({src,kind:language===1?'官方展示图 · 点击放大':'Official image · enlarge',photo:true});
  const own=[diagram('sweep-scope'),diagram('sweep-keep'),{src:new URL(`./assets/manager-${lang}.png`,import.meta.url).href,kind:language===1?'既有界面图 0.3.2 · 放大':'Repository UI 0.3.2 · enlarge',photo:true},{src:new URL(`./assets/popup-${lang}.png`,import.meta.url).href,kind:language===1?'既有界面图 0.3.2 · 放大':'Repository UI 0.3.2 · enlarge',photo:true}];
  const rivals={clickandclean:[diagram('rival-scope'),diagram('rival-keep'),official(browserNative),diagram('rival-comfort')],betterhistory:[diagram('better-scope'),diagram('better-keep'),official(better),official(better)],clearcache:[official(clear),official(clear),official(clear),official(clear)],oneclick:[official(oneclick),official(oneclick),official(oneclick),official(oneclick)],clickclean:[official(hotcleaner),official(hotcleaner),official(hotcleaner),official(hotcleaner)]};
  return {own,rival:rivals[product]};
}
