import pandas as pd, numpy as np
pd.set_option('display.width',250); pd.set_option('display.max_rows',500); pd.set_option('display.max_columns',50)
b=pd.read_pickle('/work/beacons.pkl')
b['bin']=(b.rel//30).astype(int)
c=b.groupby(['bin','sensor']).size().unstack()
nb=b.groupby('sensor')['wlan.bssid'].nunique()
print((c/nb/ (30/0.1024)).round(3).to_string())
# small dt (<0.09) - duplicates?
print(b[b.dt<0.09][['sensor','wlan.bssid','rel','dt']].head(30).to_string())
print(b[b.dt<0.09].groupby('sensor').size())
