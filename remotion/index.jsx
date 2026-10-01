import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {Opening} from './Opening.jsx';

const Root = () => <>
  <Composition id="Opening" component={Opening} durationInFrames={270} fps={30} width={900} height={900} defaultProps={{lang: 'en'}} />
</>;

registerRoot(Root);
