//! Wry 0.54's macOS UI delegate implements popup creation, but omits the public
//! WKUIDelegate.webViewDidClose callback. Forward every existing Wry callback
//! through a per-popup proxy and handle only close; never replace window.close
//! in page JavaScript or expose an app command to the remote page.
use objc2::{define_class, msg_send, rc::Retained, runtime::{AnyObject, Bool, NSObject, ProtocolObject, Sel}, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_foundation::NSObjectProtocol;
use objc2_web_kit::{WKUIDelegate, WKWebView};
use tauri::{Manager, WebviewWindow};

struct PopupDelegateIvars {
    original: Retained<ProtocolObject<dyn WKUIDelegate>>,
    app: tauri::AppHandle,
    label: String,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PopupDelegateIvars]
    struct SpecrailsPopupDelegate;

    unsafe impl NSObjectProtocol for SpecrailsPopupDelegate {
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> bool {
            selector == sel!(webViewDidClose:) || unsafe {
                let own: Bool = msg_send![super(self), respondsToSelector: selector];
                own.as_bool() || self.ivars().original.respondsToSelector(selector)
            }
        }
    }

    impl SpecrailsPopupDelegate {
        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target(&self, _selector: Sel) -> *const AnyObject {
            Retained::as_ptr(&self.ivars().original).cast()
        }
    }

    unsafe impl WKUIDelegate for SpecrailsPopupDelegate {
        #[unsafe(method(webViewDidClose:))]
        unsafe fn did_close(&self, _view: &WKWebView) {
            let app = self.ivars().app.clone();
            let label = self.ivars().label.clone();
            // Defer destruction until WebKit returns from the delegate callback.
            tauri::async_runtime::spawn(async move {
                if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); }
            });
        }
    }
);

// Association ownership is tied to the WKWebView, whose UI delegate is weak.
// A distinct address is used as the key; there is no global delegate mutation.
static DELEGATE_KEY: u8 = 0;

pub fn install_close_handler(window: &WebviewWindow) -> Result<(), String> {
    // on_new_window is synchronous on macOS. Installing before returning its
    // WKWebView also handles an immediate window.close() on the first page.
    if MainThreadMarker::new().is_none() { return Err("popup delegate requires the main thread".into()); }
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let (send, receive) = std::sync::mpsc::channel();
    window.with_webview(move |platform| unsafe {
        let view: &WKWebView = &*platform.inner().cast();
        let Some(original) = view.UIDelegate() else { let _ = send.send(Err("popup UI delegate is unavailable".into())); return; };
        let Some(main_thread) = MainThreadMarker::new() else { let _ = send.send(Err("popup delegate requires the main thread".into())); return; };
        let proxy = main_thread.alloc::<SpecrailsPopupDelegate>().set_ivars(PopupDelegateIvars { original, app, label });
        let proxy: Retained<SpecrailsPopupDelegate> = msg_send![super(proxy), init];
        objc2::ffi::objc_setAssociatedObject(
            (view as *const WKWebView).cast_mut().cast(),
            (&DELEGATE_KEY as *const u8).cast(),
            Retained::as_ptr(&proxy).cast_mut().cast(),
            objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
        view.setUIDelegate(Some(ProtocolObject::from_ref(&*proxy)));
        let _ = send.send(Ok(()));
    }).map_err(|e| e.to_string())?;
    receive.try_recv().map_err(|_| "popup delegate was not installed synchronously".to_string())?
}
