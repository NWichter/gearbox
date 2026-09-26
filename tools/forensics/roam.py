import pandas as pd, numpy as np
pd.set_option('display.width',300); pd.set_option('display.max_rows',3000); pd.set_option('display.max_columns',60); pd.set_option('display.max_colwidth',120)
e=pd.read_pickle('/work/ev2.pkl')
a=e[e.st==1]
g=a.groupby('cli').agg(n=('rel','size'),aps=('wlan.bssid',lambda s:','.join(sorted(set(x[-8:] for x in s)))),sens=('sensor',lambda s:','.join(map(str,sorted(set(s))))),aid=('wlan.fixed.aid',lambda s:','.join(sorted(set(s)))))
print(g.to_string())
print('clients with >1 AP:', (g.aps.str.contains(',')).sum())
d=e[(e.st==12)&(e['wlan.fixed.reason_code']=='0x0017')]
x=d[(d.rel>=70)&(d.rel<=120)]
print('rc23 deauths 70-120s:',len(x), x.cli.nunique()); print(x[['rel','sensor','cli','wlan.bssid']].to_string())
# first rc2 deauth/disassoc per client
r=e[(e.st.isin([10,12]))&(e['wlan.fixed.reason_code']=='0x0002')]
print(r.groupby(['cli','st']).rel.agg(['min','max','size']).sort_values('min').to_string())
