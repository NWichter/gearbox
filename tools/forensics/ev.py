import pandas as pd, numpy as np
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000); pd.set_option('display.max_columns',50); pd.set_option('display.max_colwidth',40)
b=pd.read_pickle('/work/beacons.pkl')
x=b[b.dt<0.09]
print(x.groupby('sensor').rel.apply(lambda s: sorted(set(s.round(1)))))
df=pd.read_pickle('/work/all.pkl')
e=df[~df.st.isin([8,5,29,4])].copy()
e.to_pickle('/work/events.pkl')
cols=['sensor','rel','st','wlan.ta','wlan.ra','wlan.bssid','wlan.seq','wlan.fc.retry','wlan.fixed.reason_code','wlan.fixed.status_code','wlan.fixed.auth_seq','wlan_rsna_eapol.keydes.msgnr','eap.code','eap.type','eap.identity','radiotap.dbm_antsignal','ssid_txt']
print(e[cols].sort_values('rel').head(200).to_string())
