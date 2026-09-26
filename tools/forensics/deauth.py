import pandas as pd, numpy as np
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000); pd.set_option('display.max_columns',60)
df=pd.read_pickle('/work/all.pkl')
df['seq']=pd.to_numeric(df['wlan.seq'],errors='coerce')
df['sig']=pd.to_numeric(df['radiotap.dbm_antsignal'].str.split(',').str[0],errors='coerce')
b=df[df.st==8]
apsig=b.groupby(['sensor','wlan.bssid']).sig.first()
d=df[df.st.isin([10,12])].copy()
d['apsig']=[apsig.get((s,x),np.nan) for s,x in zip(d.sensor,d['wlan.ta'])]
d['sigdiff']=d.sig-d.apsig
print(d.groupby(['st','wlan.fixed.reason_code','wlan.fc.retry']).sigdiff.describe())
g=d.groupby(['st','wlan.fixed.reason_code','sensor','wlan.ta','wlan.ra']).agg(n=('rel','size'),first=('rel','min'),last=('rel','max'),medgap=('rel',lambda s: s.sort_values().diff().median()))
print(g.to_string())
# seq consistency: for each AP-sent deauth, compare with AP's other mgmt frames (probe resp/auth/assoc) nearest in time
m=df[(df.st.isin([1,5,11,13,10,12]))&(df['wlan.ta'].str.startswith('00:0b:86',na=False))][['sensor','wlan.ta','rel','seq','st']].sort_values('rel')
out=[]
for (s,ta),grp in m.groupby(['sensor','wlan.ta']):
    grp=grp.sort_values('rel').reset_index(drop=True)
    grp['prevseq']=grp.seq.shift(); grp['nextseq']=grp.seq.shift(-1); grp['prevst']=grp.st.shift()
    out.append(grp)
m2=pd.concat(out)
dd=m2[m2.st.isin([10,12])].copy()
dd['dprev']=(dd.seq-dd.prevseq)%4096; dd['dnext']=(dd.nextseq-dd.seq)%4096
print('seq delta vs previous AP mgmt frame', dd.dprev.describe(), dd.dprev.value_counts().head(10))
print(dd[(dd.dprev>50)&(dd.dprev<4000)].head(40).to_string())
