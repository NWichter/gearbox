import pandas as pd, numpy as np
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000); pd.set_option('display.max_columns',60)
df=pd.read_pickle('/work/all.pkl')
df['retry']=df['wlan.fc.retry'].isin(['1','True'])
df['sig']=pd.to_numeric(df['radiotap.dbm_antsignal'].str.split(',').str[0],errors='coerce')
df['noise']=pd.to_numeric(df['radiotap.dbm_antnoise'].str.split(',').str[0],errors='coerce')
print(df.groupby('st').retry.agg(['sum','mean']))
print(df.groupby('st')['radiotap.datarate'].value_counts().to_string())
df['bin']=(df.rel//60).astype(int)
print('retry frac per min per sensor (non-beacon)'); nb=df[df.st!=8]
print(nb.groupby(['bin','sensor']).retry.mean().unstack().round(3).to_string())
print('noise mean per min per sensor'); print(df.groupby(['bin','sensor']).noise.mean().unstack().round(2).to_string())
print('noise per-sensor value counts', df.groupby('sensor').noise.value_counts().unstack())
print('duration', df.groupby('st')['wlan.duration'].agg(lambda s: s.value_counts().head(3).to_dict()))
