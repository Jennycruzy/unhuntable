//! Minimal blocking HTTPS over wasi:http (no URL-parsing crates, small wasm).
use wasi::http::outgoing_handler;
use wasi::http::types::{Fields, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme};
use wasi::io::streams::StreamError;

pub fn request(method: &str, url: &str, body: Option<&[u8]>) -> Result<(u16, Vec<u8>), String> {
    let rest = url.strip_prefix("https://").ok_or("https only")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let h = Fields::new();
    let _ = h.append(&"user-agent".to_string(), &b"unhuntable-guard/0.1".to_vec());
    if body.is_some() {
        let _ = h.append(&"content-type".to_string(), &b"application/json".to_vec());
    }
    let req = OutgoingRequest::new(h);
    req.set_method(if method == "POST" { &Method::Post } else { &Method::Get }).map_err(|_| "method")?;
    req.set_scheme(Some(&Scheme::Https)).map_err(|_| "scheme")?;
    req.set_authority(Some(authority)).map_err(|_| "authority")?;
    req.set_path_with_query(Some(path)).map_err(|_| "path")?;
    let ob = req.body().map_err(|_| "body")?;
    if let Some(b) = body {
        let w = ob.write().map_err(|_| "write")?;
        for c in b.chunks(4096) {
            w.blocking_write_and_flush(c).map_err(|e| format!("write {e:?}"))?;
        }
        drop(w);
    }
    OutgoingBody::finish(ob, None).map_err(|e| format!("finish {e:?}"))?;
    let opt = RequestOptions::new();
    let _ = opt.set_connect_timeout(Some(3_000_000_000));
    let _ = opt.set_first_byte_timeout(Some(5_000_000_000));
    let fut = outgoing_handler::handle(req, Some(opt)).map_err(|e| format!("{authority}: {e:?}"))?;
    let resp = match fut.get() {
        Some(r) => r,
        None => {
            fut.subscribe().block();
            fut.get().ok_or("no response")?
        }
    }
    .map_err(|_| "taken")?
    .map_err(|e| format!("{authority}: {e:?}"))?;
    let status = resp.status();
    let ib = resp.consume().map_err(|_| "consume")?;
    let st = ib.stream().map_err(|_| "stream")?;
    let mut out = Vec::new();
    loop {
        match st.blocking_read(65536) {
            Ok(mut c) => out.append(&mut c),
            Err(StreamError::Closed) => break,
            Err(e) => return Err(format!("read {e:?}")),
        }
    }
    drop(st);
    Ok((status, out))
}
