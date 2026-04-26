import os,hashlib,curl_cffi,traceback,time,ctypes,threading
from concurrent.futures import ThreadPoolExecutor

set_title=ctypes.windll.kernel32.SetConsoleTitleW
progress_lock=threading.Lock()
completed=0
total_files=0
mismatch_lock=threading.Lock()

client=curl_cffi.Session(
    impersonate="chrome146",
    default_headers=False,
    timeout=120,
    base_url="https://apps.kaonadn.net/5185710160084992/",
    headers={
        "user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
    }
)

def write_file(filename:str,data:bytes):
    path=f"./dumps/{filename}"
    os.makedirs(os.path.dirname(path),exist_ok=True)
    with open(path,"wb+") as f:
        f.write(data)

HASHES={32:hashlib.md5,40:hashlib.sha1,64:hashlib.sha256}
def verify(data:bytes,expected:str)->bool:
    return HASHES[len(expected)](data).hexdigest()==expected

def fetch(url:str,expected:str):
    global completed
    path=f"./dumps/{url}"
    if os.path.exists(path):
        with open(path,"rb") as f:
            existing=f.read()
        if verify(existing,expected):
            print(f"SKIP {url}")
            with progress_lock:
                completed+=1
                set_title(f"{completed}/{total_files}")
            return
    while True:
        try:
            data=client.get(url).content
            break
        except:
            traceback.print_exc()
            time.sleep(2)
    if not verify(data,expected):
        actual=HASHES[len(expected)](data).hexdigest()
        print(f"MISMATCH {url}")
        with mismatch_lock:
            with open("mismatches.txt","a") as f:
                f.write(f"{url} expected={expected} actual={actual} size={len(data)}\n")
    else:
        write_file(url,data)
        print(f"OK {url}")
    with progress_lock:
        completed+=1
        set_title(f"{completed}/{total_files}")

write_file("lepton.js",client.get("lepton.js").content)
write_file("lepton_webgl_obf.js",client.get("lepton_webgl/lepton_webgl_obf.js").content)

resp=client.get("manifest.webgl.txt")
write_file("manifest.webgl.txt",resp.content)

entries=[]
for i,line in enumerate(resp.text.splitlines()):
    if (i%2)==0:
        url,hash=line.rsplit(" ",1)
        entries.append((url,hash))

total_files=len(entries)
set_title(f"0/{total_files}")

with ThreadPoolExecutor(max_workers=32) as ex:
    list(ex.map(lambda e:fetch(*e),entries))
